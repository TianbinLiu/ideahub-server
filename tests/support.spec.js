/**
 * App「AI 客服」：/api/support 与 /api/admin/support 的契约测试。
 * 上游 LLM 用 jest.mock 换成固定脚本；邮件也 mock 掉（只断言"发了、发给谁"）。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const mockSendEmail = jest.fn(async () => ({ ok: true, provider: "mock" }));
jest.mock("../src/services/email.service", () => ({
  sendEmail: (...args) => mockSendEmail(...args),
  sendEmailOtp: jest.fn(async () => ({ ok: true })),
}));

// 第一轮：正常回答；第二轮（用户提到退款）：开头带 [handoff:billing]
const mockState = { scriptIndex: 0 };
const mockScripts = [
  ["[neutral][face:normal][acti", "on:explain] 这一发的钱在提交那一刻就扣掉了，取回不再花钱。", " [happy][face:happy][action:acknowledge] 打开出片页点「取回」就行。"],
  ["[hand", "off:billing] [sad][face:sad][action:comfort] 退款我没法直接处理，帮你转人工。", " [neutral][face:normal][action:explain] 请补充任务号。"],
];
jest.mock("../src/services/aiClient", () => {
  const actual = jest.requireActual("../src/services/aiClient");
  return {
    ...actual,
    hasAiKey: () => true,
    aiComplete: async () => ({ text: '```json\n{"subject":"要求退款","summary":"用户认为出片失败应退款；AI 已说明受理后不退。","category":"billing"}\n```', model: "mock" }),
    aiChatStream: async function* () {
      const chunks = mockScripts[Math.min(mockState.scriptIndex++, mockScripts.length - 1)];
      for (const c of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield c;
      }
    },
  };
});

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  mockSendEmail.mockClear();
  mockState.scriptIndex = 0;
});

async function createUser(role = "user", email) {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `sup_${random}`, email: email || `${random}@test.local`, role, passwordHash: "hashed" });
  return { user, token: signToken(user) };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => ({ event: /event: (\w+)/.exec(block)[1], data: JSON.parse(/data: (.*)/.exec(block)[1]) }));
}

describe("GET /api/support/config", () => {
  it("游客可读：名字、是否启用、快捷问题、知识库节数", async () => {
    const res = await request(app).get("/api/support/config");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.quickQuestions.length).toBeGreaterThan(3);
    expect(res.body.knowledgeSections).toBeGreaterThan(20);
  });
});

describe("POST /api/support/chat", () => {
  it("未登录 401", async () => {
    const res = await request(app).post("/api/support/chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("正常问答：逐句 sentence，done.handoff 为假", async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post("/api/support/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ messages: [{ role: "user", content: "出片一直没结果，钱扣了怎么取回？" }] });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data.text);
    expect(sentences).toEqual(["这一发的钱在提交那一刻就扣掉了，取回不再花钱。", "打开出片页点「取回」就行。"]);
    expect(events.some((e) => e.event === "handoff")).toBe(false);
    expect(events.find((e) => e.event === "done").data.handoff).toBe(false);
  });

  it("转人工：开头 [handoff:billing] 被识别成 handoff 事件且不进正文", async () => {
    const { token } = await createUser();
    mockState.scriptIndex = 1;
    const res = await request(app)
      .post("/api/support/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ messages: [{ role: "user", content: "我要退款" }] });
    const events = parseSse(res.text);
    const handoff = events.find((e) => e.event === "handoff");
    expect(handoff.data).toEqual({ category: "billing", reason: "" });
    const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data);
    expect(sentences.map((s) => s.text)).toEqual(["退款我没法直接处理，帮你转人工。", "请补充任务号。"]);
    expect(sentences[0].face).toBe("sad");
    sentences.forEach((s) => expect(s.text).not.toMatch(/handoff|\[/));
    const done = events.find((e) => e.event === "done").data;
    expect(done.handoff).toBe(true);
    expect(done.category).toBe("billing");
  });
});

describe("工单：用户侧", () => {
  it("建单 → 管理员收 SUPPORT_TICKET 通知 + 邮件；10 分钟内重复建单复用", async () => {
    const Notification = require("../src/models/Notification");
    const admin = await createUser("admin", "admin@ideahubs.org");
    const qqAdmin = await createUser("admin", "qq_123@no-email.ideahub.local");
    const { user, token } = await createUser();

    const transcript = [
      { role: "user", content: "出片失败了还扣了钱，我要退款" },
      { role: "assistant", content: "受理之后的失败不退款，我帮你转人工。" },
    ];
    const res = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ transcript, note: "任务号 abc123", contactEmail: "me@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.ticket).toMatchObject({ status: "open", category: "billing", subject: "要求退款" });
    expect(res.body.ticket.transcript).toHaveLength(2);
    // 用户侧不回联系邮箱之外的管理信息
    expect(res.body.ticket.user).toBeUndefined();

    const notifs = await Notification.find({ type: "SUPPORT_TICKET" }).lean();
    expect(notifs.map((n) => String(n.userId)).sort()).toEqual([String(admin.user._id), String(qqAdmin.user._id)].sort());
    expect(notifs[0].payload).toMatchObject({ ticketId: res.body.ticket.id, category: "billing", username: user.username });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const mail = mockSendEmail.mock.calls[0][0];
    // 合成邮箱（QQ 账号）不该收到邮件
    expect(mail.to).toEqual(["admin@ideahubs.org"]);
    expect(mail.subject).toContain("新工单");
    expect(mail.text).toContain("任务号 abc123");
    expect(mail.text).toContain("me@example.com");

    const again = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({ transcript, note: "再点一次" });
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.ticket.id).toBe(res.body.ticket.id);

    const mine = await request(app).get("/api/support/tickets/mine").set("Authorization", `Bearer ${token}`);
    expect(mine.body.items).toHaveLength(1);
  });

  it("空单（没对话也没备注）400；追加消息会重新打开已结工单", async () => {
    const { user, token } = await createUser();
    await createUser("admin", "admin@ideahubs.org");
    const empty = await request(app).post("/api/support/tickets").set("Authorization", `Bearer ${token}`).send({ transcript: [] });
    expect(empty.status).toBe(400);

    const SupportTicket = require("../src/models/SupportTicket");
    const ticket = await SupportTicket.create({ userId: user._id, status: "resolved", subject: "旧单", summary: "x" });
    const res = await request(app)
      .post(`/api/support/tickets/${ticket._id}/messages`)
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "问题又出现了" });
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe("open");
    expect(res.body.ticket.replies).toHaveLength(1);
    expect(res.body.ticket.replies[0].by).toBe("user");

    // 别人的工单 404
    const other = await createUser();
    const stranger = await request(app)
      .post(`/api/support/tickets/${ticket._id}/messages`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ content: "我也要" });
    expect(stranger.status).toBe(404);
  });
});

describe("工单：管理员侧", () => {
  it("非管理员 401/403", async () => {
    const { token } = await createUser();
    expect((await request(app).get("/api/admin/support/tickets")).status).toBe(401);
    expect((await request(app).get("/api/admin/support/tickets").set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("列表 / 回复（用户收 SUPPORT_REPLY 且看不到是哪个管理员）/ 改状态", async () => {
    const Notification = require("../src/models/Notification");
    const SupportTicket = require("../src/models/SupportTicket");
    const admin = await createUser("admin");
    const { user, token } = await createUser("user", "owner@example.com");
    const ticket = await SupportTicket.create({ userId: user._id, subject: "装不上", summary: "提示应用未安装", category: "bug", transcript: [{ role: "user", content: "装不上" }] });

    const list = await request(app).get("/api/admin/support/tickets?status=open").set("Authorization", `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.openCount).toBe(1);
    expect(list.body.items[0].user.username).toBe(user.username);
    expect((await request(app).get("/api/admin/support/tickets?status=nope").set("Authorization", `Bearer ${admin.token}`)).status).toBe(400);

    const reply = await request(app)
      .post(`/api/admin/support/tickets/${ticket._id}/reply`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ content: "先卸载旧测试版再装。" });
    expect(reply.status).toBe(200);
    expect(reply.body.ticket.status).toBe("in_progress");
    expect(reply.body.ticket.replies[0]).toMatchObject({ by: "admin", content: "先卸载旧测试版再装。" });

    const notif = await Notification.findOne({ userId: user._id, type: "SUPPORT_REPLY" }).lean();
    expect(notif.payload).toMatchObject({ ticketId: String(ticket._id), kind: "reply" });
    expect(notif.actorId ?? null).toBeNull();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe("owner@example.com");

    const status = await request(app)
      .patch(`/api/admin/support/tickets/${ticket._id}/status`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ status: "resolved" });
    expect(status.body.ticket.status).toBe("resolved");
    const statusNotif = await Notification.findOne({ userId: user._id, type: "SUPPORT_REPLY", "payload.kind": "status" }).lean();
    expect(statusNotif.payload.status).toBe("resolved");

    const mine = await request(app).get("/api/support/tickets/mine").set("Authorization", `Bearer ${token}`);
    expect(mine.body.items[0].replies).toHaveLength(1);
    expect(mine.body.items[0].contactEmail).toBeUndefined();
  });
});

describe("support.service 纯函数", () => {
  const svc = require("../src/services/support.service");

  it("检索：取回类问题一定带上 4.6 与禁止承诺清单", () => {
    const k = svc.selectKnowledge("出片一直没结果，钱扣了怎么取回？");
    expect(k).toContain("「取回」= 避免二次付费");
    expect(k).toContain("客服禁止承诺的事项");
    expect(k).toContain("support@ideahubs.org");
    expect(k.length).toBeLessThan(12000);
  });

  it("检索：注销问题命中 2.6；iOS 问题命中下载页", () => {
    expect(svc.selectKnowledge("怎么注销账号？")).toContain("注销账号");
    expect(svc.selectKnowledge("有苹果版吗")).toContain("iOS 版还没有");
  });

  it("parseHandoff / categoryFromText", () => {
    expect(svc.parseHandoff("[handoff:account] 好的")).toMatchObject({ handoff: true, category: "account", text: "好的" });
    expect(svc.parseHandoff("[handoff:banana] 好的").category).toBe("other");
    expect(svc.parseHandoff("[HANDOFF] x").handoff).toBe(true);
    expect(svc.parseHandoff("正常").handoff).toBe(false);
    expect(svc.categoryFromText("我要退款")).toBe("billing");
    expect(svc.categoryFromText("作品被下架了")).toBe("content");
    expect(svc.categoryFromText("打开就闪退")).toBe("bug");
  });
});

describe("满意度 👍👎", () => {
  it("用户存一条，管理员能按 rating 看并拿到统计", async () => {
    const { token } = await createUser();
    const admin = await createUser("admin");
    const bad = await request(app).post("/api/support/feedback").set("Authorization", `Bearer ${token}`).send({ question: "x", answer: "y", rating: "meh" });
    expect(bad.status).toBe(400);
    const up = await request(app)
      .post("/api/support/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "怎么取回？", answer: "点取回。", rating: "up" });
    expect(up.status).toBe(201);
    const down = await request(app)
      .post("/api/support/feedback")
      .set("Authorization", `Bearer ${token}`)
      .send({ question: "有 iOS 吗", answer: "没有。", rating: "down", reason: "太简短" });
    expect(down.status).toBe(201);

    expect((await request(app).get("/api/admin/support/feedback").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    const list = await request(app).get("/api/admin/support/feedback?rating=down").set("Authorization", `Bearer ${admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ rating: "down", question: "有 iOS 吗", reason: "太简短" });
    expect(list.body.items[0].user.username).toMatch(/^sup_/);
    expect(list.body.stats).toEqual({ up: 1, down: 1 });
    expect((await request(app).get("/api/admin/support/feedback?rating=nope").set("Authorization", `Bearer ${admin.token}`)).status).toBe(400);
  });
});
