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
    aiChatStream: async function* (messages, opts) {
      mockState.lastMessages = messages;
      mockState.lastOpts = opts;
      const chunks = mockState.script || mockScripts[Math.min(mockState.scriptIndex++, mockScripts.length - 1)];
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
  mockState.lastMessages = null;
  mockState.lastOpts = null;
  mockState.script = null;
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

  // ★ 客服这一发关思考（2026-10-20）：DeepSeek 官方 max_tokens 连思维链一起算，700 的上限会被思考吃光、回答截断或一个字都没有；
  //   只关客服这一条（陪聊那一发不带 thinking，见 companion.spec）
  it("客服那一发带 thinking:false，上限仍是 700；截断时有日志可查", async () => {
    const { token } = await createUser();
    await request(app)
      .post("/api/support/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ messages: [{ role: "user", content: "出片一直没结果，钱扣了怎么取回？" }] });
    expect(mockState.lastOpts).toMatchObject({ thinking: false, maxTokens: 700 });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockState.lastOpts.onFinish("length", "deepseek-flash");
    expect(warn.mock.calls[0][0]).toMatch(/reply cut by max_tokens/);
    warn.mockRestore();
  });

  // ★ 关思考后 DeepSeek 更常把标签写成等号（真模型 107 条里 19 条）：标签跨 chunk、句中漏网，正文里都不许留方括号
  it("模型把标签写成 [face=normal][action=explain]：照样解析、正文不留方括号", async () => {
    const { token } = await createUser();
    mockState.script = ["[neutral][face=nor", "mal][action=explain] 过 6 秒提示收起就没入口了。", " [happy][face=happy] 删错了点「撤销」 [action=acknowledge] 就能放回。"];
    const res = await request(app)
      .post("/api/support/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ messages: [{ role: "user", content: "删段能撤销吗" }] });
    const sentences = parseSse(res.text)
      .filter((e) => e.event === "sentence")
      .map((e) => e.data);
    // 正文之后又来一个 "[" 时切句器会在那儿切开（协议规定标签只在句首），所以第三句自带 action
    expect(sentences.map((s) => s.text)).toEqual(["过 6 秒提示收起就没入口了。", "删错了点「撤销」", "就能放回。"]);
    expect(sentences[0]).toMatchObject({ emotion: "neutral", face: "normal", action: "explain" });
    expect(sentences[1]).toMatchObject({ emotion: "happy", face: "happy" });
    expect(sentences[2]).toMatchObject({ action: "acknowledge" });
    sentences.forEach((s) => expect(s.text).not.toMatch(/[[\]]/));
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

  // ★ App 客服页发的 lang 写死 "zh"（v2.63 SupportPage.tsx）：英文界面叫法表要看这一轮的原话，只认 lang 的话生产上一次都发不出去
  it("英文问话（lang 仍是 zh）：system 带上英文界面叫法表、回复语言那一行说这一轮用英文；中文问话两样都不变", async () => {
    const { token } = await createUser();
    const ask = (content) =>
      request(app)
        .post("/api/support/chat")
        .set("Authorization", `Bearer ${token}`)
        .send({ messages: [{ role: "user", content }], lang: "zh" });
    await ask("Where did the Refined image tier go?");
    const enSystem = mockState.lastMessages[0];
    expect(enSystem.role).toBe("system");
    expect(enSystem.content).toContain("【英文界面叫法】");
    expect(enSystem.content).toContain("Lite（");
    expect(enSystem.content).toContain("用户这一问是英文，这一轮就用英文回答。");
    await ask("定妆档去哪了");
    expect(mockState.lastMessages[0].content).not.toContain("英文界面叫法");
    expect(mockState.lastMessages[0].content).toContain("默认用中文回复；用户用英文就用英文。");
  });

  // ★ 2026-10-20 生产核对：中文用户顺手追问一句「ok」「QQ」「token」「HD」，原来就被判成英文、提示词说死「这一轮就用英文回答」。
  //   只有真英文问法（至少两个实词）才说死；判不了的退回那句软话（模型自己看）
  it("中文对话里追问一句短拉丁词（ok / QQ / token / HD…）：不说死用英文、不带英文界面叫法表；真英文问法照旧", async () => {
    const { token } = await createUser();
    const followUp = async (content) => {
      mockState.script = ["[neutral][face:normal][action:explain] 好的。"];
      await request(app)
        .post("/api/support/chat")
        .set("Authorization", `Bearer ${token}`)
        .send({
          messages: [
            { role: "user", content: "出片一直没结果，钱扣了怎么取回？" },
            { role: "assistant", content: "到出片页点「取回」就行。" },
            { role: "user", content },
          ],
          lang: "zh",
        });
      return mockState.lastMessages[0].content;
    };
    for (const q of ["ok", "OK", "QQ", "UID", "APK", "VIP", "token", "HD", "hi", "thx", "2.63", "v2.63"]) {
      const sys = await followUp(q);
      expect(sys).not.toContain("英文界面叫法");
      expect(sys).toContain("默认用中文回复；用户用英文就用英文。");
    }
    for (const q of ["how do I undo", "merge failed", "Refund please"]) {
      const sys = await followUp(q);
      expect(sys).toContain("【英文界面叫法】");
      expect(sys).toContain("用户这一问是英文，这一轮就用英文回答。");
    }
  });

  // ★ 2026-10-20 复核：① 中文用户只贴一个任务号 / 邮箱 / 链接（客服让报的正是这些），原来照样凑出两个「英文词」说死英文；
  //   ② 反过来，英文用户的短追问（「Why?」「Refund」、贴任务号）在收紧之后退成了软话 —— 跟着上一问走
  it("只贴任务号 / 邮箱 / 链接：中文会话不说死英文；英文会话里的短追问照旧说死英文", async () => {
    const { token } = await createUser();
    const ask = async (first, content) => {
      mockState.script = ["[neutral][face:normal][action:explain] 好的。"];
      await request(app)
        .post("/api/support/chat")
        .set("Authorization", `Bearer ${token}`)
        .send({
          messages: [
            { role: "user", content: first },
            { role: "assistant", content: "好的。" },
            { role: "user", content },
          ],
          lang: "zh",
        });
      return mockState.lastMessages[0].content;
    };
    const pasted = ["cgt-20251020150103-abx9z", "abc123@qq.com", "tliu@gmail.com", "https://ideahubs.org/download", "ideahubs.org", "6712abcdef0123456789abcd", "hhhh hhhh"];
    for (const q of pasted) {
      const sys = await ask("出片一直没结果，钱扣了怎么取回？", q);
      expect([q, sys.includes("英文界面叫法")]).toEqual([q, false]);
    }
    for (const q of ["Why?", "Refund", "ok", "Thanks!", ...pasted, "1234567", "👍"]) {
      const sys = await ask("My video never finished and I was charged. How do I get it back?", q);
      expect([q, sys.includes("用户这一问是英文，这一轮就用英文回答。")]).toEqual([q, true]);
    }
    // 英文问完、这一问换回中文：照中文
    const zh = await ask("My video never finished and I was charged. How do I get it back?", "那要多久");
    expect(zh).not.toContain("英文界面叫法");
  });

  // ★ 2026-10-20 生产核对：转人工标记只认半角冒号，模型写成 [handoff=billing] / [handoff：billing] 时标记被剥掉（看不见）、却没有 handoff 事件 ——
  //   用户要找人工什么都等不到。分隔符与 companion.parseTags 同一个口径；整条路走真的路由（开头攒前缀 → 切句 → 演出标签 → 句首转人工 → 清理）
  it.each([
    ["等号、跨 chunk", ["[handoff=bil", "ling] [sad][face=sad][action=comfort] 退款要人工核对，我这边没法直接处理。", " [neutral][face:normal][action:explain] 请点下面的「转人工」。"], "billing", "", "sad"],
    ["全角冒号", ["[handoff：account] [sad][face:sad][action:comfort] 恢复账号要人工处理。"], "account", "", "sad"],
    ["方括号里有空格、跨 chunk", ["[ hand", "off = bug ] [sad][face:sad][action:comfort] 这像是程序的问题。"], "bug", "", "sad"],
    ["等号带理由", ["[handoff=billing=用户要求退款] [sad][face:sad][action:comfort] 退款要人工核对。"], "billing", "用户要求退款", "sad"],
    ["写在第二句句首", ["[neutral][face=normal][action=explain] 下架申诉我这边处理不了。", " [sad][face=sad][action=comfort] [handoff=content] 请点下面的「转人工」。"], "content", "", "normal"],
  ])("转人工标记写成别的分隔符（%s）：照样发 handoff 事件，正文不留标记", async (_name, script, category, reason, firstFace) => {
    const { token } = await createUser();
    mockState.script = script;
    const res = await request(app)
      .post("/api/support/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ messages: [{ role: "user", content: "我要找人工" }] });
    const events = parseSse(res.text);
    expect(events.filter((e) => e.event === "handoff").map((e) => e.data)).toEqual([{ category, reason }]);
    const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data);
    expect(sentences.length).toBeGreaterThan(0);
    expect(sentences[0].face).toBe(firstFace);
    sentences.forEach((s) => expect(s.text).not.toMatch(/handoff|[[\]]/i));
    expect(events.find((e) => e.event === "done").data).toMatchObject({ handoff: true, category });
  });

  it("按会话：方括号里带空格的转人工标记也不进历史原文", async () => {
    const ChatMessage = require("../src/models/ChatMessage");
    const { token } = await createUser();
    mockState.script = ["[ handoff=bug] ", "[sad][face=sad][action=none]抱歉，我帮你转人工。"];
    const events = parseSse((await request(app).post("/api/support/chat").set("Authorization", `Bearer ${token}`).send({ message: "导出一直失败" })).text);
    const done = events.find((e) => e.event === "done").data;
    expect(done).toMatchObject({ handoff: true, category: "bug" });
    const reply = await ChatMessage.findOne({ thread: done.threadId, role: "assistant" }).lean();
    expect(reply.modelText).not.toMatch(/handoff/i);
    expect(reply.displayText).toBe("抱歉，我帮你转人工。");
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
    // ★ 长度（2026-10-19 改）：原来写死 < 12000，2.63 修订后这一问是 12,145 字 —— 永远带上的三节 5,115 + 挑出来的四节 7,018，
    //   多出来的全是知识库正文变长，检索没有多挑一节。两道闸分开钉：永远带上的三节（禁止承诺 / 转人工判定 / 联系方式）合计别过 6000
    //   —— 它们每一问都在，涨一字就是每一问多一字；整份上限放到 13000（量出来的 12,145 + 余量）。
    //   ⚠ 别写成「≤ 8000 + 三节」：selectKnowledge 本身就按 8000 截，那样写恒真、等于没有上限（10-19 复核抓到）。
    //   再撑破 13000 就回正本删字，别再往上抬。
    const always = svc.loadKnowledge().sections.filter((s) => s.always);
    const alwaysLen = always.reduce((n, s) => n + s.text.length, 0);
    expect(alwaysLen).toBeLessThan(6000);
    expect(k.length).toBeLessThan(13000);
  });

  it("检索：注销问题命中 2.6；iOS 问题命中下载页", () => {
    expect(svc.selectKnowledge("怎么注销账号？")).toContain("注销账号");
    expect(svc.selectKnowledge("有苹果版吗")).toContain("iOS 版还没有");
  });

  // 标题（去掉编号之后）以 title 开头的那一节，在喂给模型的那几节里排第几（每节以自己的 ## / ### 标题行开头；没喂进去 = 0）。
  // 按标题行认、不按正文认：同一串字可能也出现在排在前面的别的节的正文里
  function rankOf(knowledge, title) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`^#{2,3} \\S+ ${esc}`, "m").exec(knowledge);
    if (!m) return 0;
    return (knowledge.slice(0, m.index).match(/^#{2,3} /gm) || []).length + 1;
  }

  // ★ 2026-10-19 发版后验证查出来的：2.63 的这几件，单句问法要把对的那一节排进前 3、而且真的喂进去（没被 8000 字挤掉）。
  //   问法照用户的说法写（撤回 / 找回、合并、v2.63、英文），不是照知识库的用词写
  // ★ 2.64 发版（2026-10-21）之后，2.63 的那些挪进了 §9.3「2.58 ~ 2.63 各版更新」，§9.2 换成 2.64：问 2.63 的要落在 §9.3，
  //   问「最新版本」的落在 §9.2（版本号怎么分节见 support.service 的 versionExtras）
  // ★ 2.71 发版（2026-10-29）之后 §9.3 收到 2.70，标题换成「2.58 ~ 2.72 各版更新」，§9.2 换成 2.71（下面「检索（2.71）」那一组）
  // ★ 2.74 发版（2026-10-29）之后 §9.3 收到 2.73（标题「2.58 ~ 2.73 各版更新」），§9.2 换成 2.74
  it.each([
    ["2.63 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["v2.63 有什么新功能", "2.58 ~ 2.73 各版更新"],
    ["最新版本有什么变化", "最新版本：当前版 2.74"],
    ["删了一段能撤回吗", "删掉一段与撤销"],
    ["删掉的段能找回来吗", "删掉一段与撤销"],
    ["删草稿能撤销吗", "草稿"],
    ["画布怎么放大缩小", "工作流画布：放大 / 缩小"],
    ["登录时提示忽略了一条不是本机发起的登录链接", "Google / GitHub 登录没登上"],
    ["登录链接过期了是怎么回事", "Google / GitHub 登录没登上"],
    ["剪辑页合成失败怎么办", "剪辑页合成：报错"],
    ["剪辑页合并失败", "剪辑页合成：报错"],
    ["以后会强制更新吗", "更新机制"],
    ["定妆档怎么没了", "出图档位"],
    ["11 月 24 日之后速写还能用吗", "出图档位"],
    ["What's new in version 2.63?", "2.58 ~ 2.73 各版更新"],
    // 输入法吞掉空格的写法（2026-10-20 主人手机上实测打出来的就是这一句）
    ["What Is New In Version2.63", "2.58 ~ 2.73 各版更新"],
    ["ver2.63 what changed", "2.58 ~ 2.73 各版更新"],
    ["Can I undo deleting a segment?", "删掉一段与撤销"],
    ["How do I zoom in on the workflow canvas?", "工作流画布：放大 / 缩小"],
    ["How do I update the app?", "更新机制"],
    ["Is version 2.63 forced?", "更新机制"],
  ])("检索（2.63）：「%s」把「%s」那一节排进前 3", (q, heading) => {
    const r = rankOf(svc.selectKnowledge(q), heading);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("检索（2.63）：剪辑页合成失败第 1 名是 3.8，不再被「失败 → 敏感词」那条顶成 4.8；AI 出片失败照旧带 4.8", () => {
    expect(rankOf(svc.selectKnowledge("剪辑页合成失败怎么办"), "剪辑页合成：报错")).toBe(1);
    expect(svc.selectKnowledge("生成失败了为什么还扣我 token？")).toContain("生成失败的典型原因");
    expect(svc.selectKnowledge("推演失败了")).toContain("生成失败的典型原因");
    // 「视频合成 / AI 合成」多半是 AI 出片：带「合成」二字不等于剪辑页（2026-10-19 复核：原来整行有合成二字就让开，
    //   这两问的 4.8 掉出前 5；「视频合成要多少钱」只喂了 3.8「合成不花 token」、价钱那两节被挤掉）
    expect(svc.selectKnowledge("AI 合成视频失败了扣 token 吗")).toContain("生成失败的典型原因");
    expect(svc.selectKnowledge("视频合成失败了扣钱吗")).toContain("生成失败的典型原因");
    expect(svc.selectKnowledge("视频合成要多少钱")).toContain("视频档位");
  });

  // ★ 2.64（2026-10-21）知识库新加的几节：单句问法要把对的那一节排进前 3、真的喂进去。问法照用户的说法写；
  //   同一批 62 句探针（中英）全过才合的，这里钉其中有代表性的，新同义词那几条每条至少一句
  it.each([
    ["2.64 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["What's new in version 2.64?", "2.58 ~ 2.73 各版更新"],
    ["这次更新要不要装，是不是安全更新", "更新机制"],
    ["首页怎么调倍速", "首页：长按菜单"],
    ["长按视频弹出来的菜单是什么", "首页：长按菜单"],
    ["双击点赞视频就停了", "首页：长按菜单"],
    ["没登录能关注作者吗", "首页：长按菜单"],
    ["搜索历史怎么删", "分区页：搜索"],
    ["近期热播是全站热榜吗", "分区页：搜索"],
    ["更新后我的卡片不见了", "创意工坊：市场与仓库"],
    ["3D 工坊入口去哪了", "创意工坊：市场与仓库"],
    ["怎么做自己的视频模板", "做模板的入口卡"],
    ["免费用户能做模板吗", "做模板的入口卡"],
    ["草稿的图标怎么变成笔了", "个人页：笔形图标"],
    ["怎么在主页拉黑一个人", "封禁 / 黑名单"],
    ["谷歌登录回来提示邮箱已经用别的方式注册过了", "Google / GitHub 登录没登上"],
    ["对话正反打每张多少钱", "九宫格分镜 / 对话正反打"],
    ["机位上有个感叹号是什么意思", "九宫格分镜 / 对话正反打"],
    ["往后延长怎么算钱", "片段重拍 / 往后延长 / 示例片的计价"],
    ["检查更新失败：连接超时", "检查更新 / 更新弹层的各种说法"],
    ["How do I change playback speed on the home feed?", "首页：长按菜单"],
    ["How do I clear my search history?", "分区页：搜索"],
    ["My cards disappeared after the update", "创意工坊：市场与仓库"],
    ["Where is My Library?", "创意工坊：市场与仓库"],
    ["How do I block someone from their profile?", "封禁 / 黑名单"],
    ["Why is the extend price higher now?", "片段重拍 / 往后延长 / 示例片的计价"],
    ["Is 2.64 a security update? Should I update?", "更新机制"],
  ])("检索（2.64）：「%s」把「%s」那一节排进前 3", (q, heading) => {
    const r = rankOf(svc.selectKnowledge(q), heading);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  // ★ 2.71 发版（2026-10-29）：§9.2 换成 2.71、§9.3 收到 2.70；新加 §6.8 作品详情页、§3.10 文字模板，§4.2 里「按模型适配」那一大块拆成 §4.2b
  //   （§4.2 长到 4 千字后按长度开方归一把它压到第 4，「HD」「视频合成要多少钱」掉出去过；§3.9 加了文字模板之后「免费用户能做模板吗」掉出前 3 —— 都是拆节治的）
  it.each([
    ["2.74 更新了什么", "最新版本：当前版 2.74"],
    ["What's new in version 2.74?", "最新版本：当前版 2.74"],
    ["新手引导开着按返回怎么就退出了", "手机返回键"],
    ["2.73 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["评论框开着按返回怎么就退出了", "手机返回键"],
    ["2.72 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["What's new in version 2.73?", "2.58 ~ 2.73 各版更新"],
    ["2.73 新增了啥", "2.58 ~ 2.73 各版更新"],
    ["2.71 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["全屏的时候按返回键怎么退出了整个页面", "手机返回键"],
    ["2.68 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["v2.66 有什么新功能", "2.58 ~ 2.73 各版更新"],
    ["2.70 改了什么", "2.58 ~ 2.73 各版更新"],
    ["What's new in version 2.65?", "2.58 ~ 2.73 各版更新"],
    ["作品详情页的倍速在哪", "作品详情页"],
    ["详情页的做同款按钮去哪了", "作品详情页"],
    ["怎么只用文字做模板", "文字模板"],
    ["提示参考图方舟没拉到", "生成失败的典型原因与文案"],
    ["按模型适配是什么意思", "按模型适配"],
    ["怎么换成 MiniMax 出片", "供应商与模型"],
    ["Seedance 和 MiniMax 有什么区别", "供应商与模型"],
  ])("检索（2.71）：「%s」把「%s」那一节排进前 3", (q, heading) => {
    const r = rankOf(svc.selectKnowledge(q), heading);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("检索：版本号按当前版分节 —— 当前版从 §9.2 标题里读，问当前版落 §9.2、问更早的落「各版更新」", () => {
    const v = svc.loadKnowledge().currentVersion;
    expect(v).toMatch(/^\d+\.\d{2}$/);
    const [major, minor] = v.split(".");
    expect(rankOf(svc.selectKnowledge(`${v} 更新了什么`), "最新版本：当前版")).toBe(1);
    const prev = `${major}.${String(Number(minor) - 1).padStart(2, "0")}`;
    expect(rankOf(svc.selectKnowledge(`${prev} 更新了什么`), `2.58 ~ ${prev} 各版更新`)).toBe(1);
  });

  // 10-21 复核抓到的（每条都是先在探针上量到错、改了规则再钉住）
  it.each([
    // 装新版：版本号把更新记录抬上来时，§7.2 不能掉出去
    ["我手机上是 2.61，怎么更新到 2.64", "更新机制"],
    ["2.64怎么更新", "更新机制"],
    // 版本号只在「问的就是这一版」时才领去更新记录
    ["2.62 更新了什么", "2.58 ~ 2.73 各版更新"],
    ["2.64 新增了啥", "2.58 ~ 2.73 各版更新"],
    // 关弹幕不是拉黑
    ["怎么屏蔽弹幕", "互动与防刷"],
    ["弹幕太多了怎么关掉", "互动与防刷"],
    ["How do I turn off danmaku?", "互动与防刷"],
    // 保存到本地（§4.4d 的标题原来带「视频」，把 §6.7 挤掉过）
    ["怎么把视频下载到相册", "保存到本地"],
    ["怎么下载我的视频", "保存到本地"],
    // 修这一段的钱、草稿的笔、客服语言
    ["修这一段要多少钱", "片段重拍 / 往后延长 / 示例片的计价"],
    ["只改其中几秒会便宜吗", "片段重拍 / 往后延长 / 示例片的计价"],
    ["草稿上的锁不见了", "个人页：笔形图标"],
    ["草稿的锁变成笔了", "个人页：笔形图标"],
    ["客服能不能说英文", "设置页"],
    ["Why does support reply in Chinese?", "设置页"],
    // en.po 里的英文叫法与更新失败的英文原话
    ["Is Remix free?", "首页：长按菜单"],
    ["Is adding cards from the market free?", "创意工坊：市场与仓库"],
    ["the over-the-shoulder shot has an extra person", "九宫格分镜 / 对话正反打"],
    ["How much does a reshoot cost", "片段重拍 / 往后延长 / 示例片的计价"],
    ["Couldn't check for updates", "检查更新 / 更新弹层的各种说法"],
    ["The update keeps failing", "检查更新 / 更新弹层的各种说法"],
    // 账号被盗去密码重置，不去 2.64 的漏洞那一条
    ["My account was hacked, what should I do?", "密码重置"],
    ["Is my data safe after the security vulnerability?", "更新机制"],
    // 广场 = 创意工坊市场；「更新后卡片没了，是不是被删了」照旧去我的仓库
    ["卡片广场在哪", "创意工坊：市场与仓库"],
    ["更新以后卡片都没了，是不是被删除了", "创意工坊：市场与仓库"],
    // 第二轮复核（10-21）：发版后最常见的「更新之后 X 在哪」问的是 X；弹幕的几种说法；模板成片没声音；铅笔；客服语言的名词说法
    ["更新到2.64后倍速在哪", "首页：长按菜单"],
    ["2.64更新了，倍速在哪", "首页：长按菜单"],
    ["我已经更新到2.64了，怎么还提示更新", "更新机制"],
    ["能不能把弹幕关了", "互动与防刷"],
    ["弹幕可以关吗", "互动与防刷"],
    ["弹幕发不出去", "互动与防刷"],
    ["模板的原声不见了", "剪辑页合成：报错"],
    ["模板的音乐没了", "剪辑页合成：报错"],
    ["草稿怎么变成铅笔了", "个人页：笔形图标"],
    ["Why is customer service in Chinese", "设置页"],
    ["Block a user who spams bullet comments", "封禁 / 黑名单"],
    ["怎么拉黑一个人", "封禁 / 黑名单"],
  ])("检索（2.64 复核）：「%s」把「%s」那一节排进前 3", (q, heading) => {
    const r = rankOf(svc.selectKnowledge(q), heading);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("检索（2.64）：新加的同义词不拉偏无关问法", () => {
    // 「extend my subscription」是套餐，不是往后延长
    expect(svc.selectKnowledge("How do I extend my subscription?")).not.toContain("片段重拍 / 往后延长 / 示例片的计价");
    // 模板的声音没了是白模成片无声，不是卡片挪进了我的仓库
    expect(svc.selectKnowledge("合成之后模板的声音没了")).not.toContain("创意工坊：市场与仓库");
    expect(svc.selectKnowledge("白模模板出的片子，模板原声没了")).toContain("剪辑页合成：报错");
    // App 里到处是 ⚠：不是九宫格 / 对话正反打的那几张图就别领去 §4.3b
    expect(rankOf(svc.selectKnowledge("更新提示里有个感叹号"), "九宫格分镜 / 对话正反打")).not.toBe(1);
    expect(rankOf(svc.selectKnowledge("发布页每段旁边都写着⚠渐变回退"), "九宫格分镜 / 对话正反打")).toBe(0);
    // 随口报的版本号不该把更新记录塞进预算
    expect(svc.selectKnowledge("我是2.63，九宫格一张多少钱")).toContain("九宫格分镜 / 对话正反打");
    expect(svc.selectKnowledge("扣了我 2.50 元")).not.toContain("2.58 ~ 2.73 各版更新");
    // 屏蔽某个人仍是拉黑；改头像不是装新版
    expect(rankOf(svc.selectKnowledge("怎么屏蔽这个人"), "封禁 / 黑名单")).toBeGreaterThanOrEqual(1);
    expect(rankOf(svc.selectKnowledge("怎么更新头像"), "更新机制")).not.toBe(1);
    // 装 App 的下载不是保存到本地
    expect(rankOf(svc.selectKnowledge("怎么把启梦下载到手机"), "下载页")).toBe(1);
    // 草稿里那笔钱不是图标
    expect(svc.selectKnowledge("草稿里那笔钱扣了吗")).not.toContain("个人页：笔形图标");
    // 别的市场（人格 / 声音）不是创意工坊
    expect(svc.selectKnowledge("Is the persona market free?")).not.toContain("创意工坊：市场与仓库");
    // 老师 / 视频人物说英文不是客服语言
    expect(rankOf(svc.selectKnowledge("启梦老师能用英文回答吗"), "设置页")).not.toBe(1);
    // 改昵称失败不是更新失败
    expect(svc.selectKnowledge("I tried to update my nickname but it failed")).not.toContain("检查更新 / 更新弹层的各种说法");
    // 第二轮复核（10-21）
    // 升级档位不是装新版；更新之后登录不上问的是登录
    expect(svc.selectKnowledge("app里怎么升级电影级")).toContain("视频档位");
    expect(svc.selectKnowledge("更新到最新版后登录不上了")).toContain("密码重置");
    // 提示词被屏蔽是内容审核，不是拉黑
    expect(svc.selectKnowledge("提示词被屏蔽了怎么办")).toContain("生成失败的典型原因与文案");
    // 语音合成的声音不是模板原声
    expect(rankOf(svc.selectKnowledge("语音合成没有声音怎么办"), "剪辑页合成：报错")).not.toBe(1);
    // 铅笔画风不是草稿的图标
    expect(svc.selectKnowledge("画风怎么变成铅笔素描")).not.toContain("个人页：笔形图标");
    // 动词 support 不是客服语言
    expect(rankOf(svc.selectKnowledge("Does Seedance support Chinese prompts?"), "设置页")).not.toBe(1);
    // remix 不该把改资料那一节拉进来
    expect(svc.selectKnowledge("How do I remix a video?")).not.toContain("昵称 / 简介 / 头像");
  });

  it("检索（2.63）：新加的同义词不拉偏无关问法", () => {
    expect(svc.selectKnowledge("两个账号能合并吗")).not.toContain("剪辑页合成：报错");
    expect(svc.selectKnowledge("How do I update my nickname?")).not.toContain("更新机制");
    expect(svc.selectKnowledge("How do I upgrade my plan?")).not.toContain("更新机制");
    // 英文界面里会员档那颗「去升级」就是 "Upgrade"：光说 upgrade 是问买套餐，不是装新版（2026-10-19 复核）
    for (const q of [
      "How do I upgrade?",
      "I want to upgrade to premium to use HD",
      "How do I upgrade to unlock the cinema option?",
      "Why can't I use HD? Do I need to upgrade?",
      "How do I update my payment method?",
    ]) {
      expect(svc.selectKnowledge(q)).not.toContain("更新机制");
    }
    expect(svc.selectKnowledge("Why can't I use HD? Do I need to upgrade?")).toContain("视频档位");
    expect(svc.selectKnowledge("Can I recover my deleted account?")).not.toContain("删掉一段与撤销");
  });

  // ★ 英文问法 → 知识库用词（EN_GLOSSARY，2026-10-20）：下面这些在没有这张表时一节都排不进前 3（多数一节都没喂进去，
  //   模型只能凭常驻 FAQ 猜；「Refined 档去哪了」真模型直接答「知识库里没有」并转人工）。问法照英文界面的叫法（en.po）写
  it.each([
    ["I want a refund.", "计费与退款"],
    ["Why was I charged tokens when the generation failed?", "计费与退款"],
    ["My video never finished generating but I was charged. How do I get it back?", "「取回」= 避免二次付费"],
    ["How do I delete my account?", "注销账号"],
    ["I forgot my password.", "密码重置"],
    ["Where did the Refined image tier go when making cards?", "出图档位"],
    ["What is the preview draft mode for Cinematic?", "电影级「样片」"],
    ["Can I log in with WeChat?", "登录方式与注册"],
    ["How do I block someone?", "封禁 / 黑名单 / 私信"],
    ["How do I save my video to my phone?", "保存到本地"],
    ["How do I make my video visible only to me?", "可见性三档"],
    ["How do I report a video?", "举报与下架"],
    ["Where are your servers and where is my data stored?", "隐私要点"],
    ["What's the longest video segment I can generate?", "时长与数量限制"],
    ["Does chatting with support cost tokens?", "对话与语音的费用"],
    // 出片档位「草稿」英文界面叫 Lite（en.po），不叫 Draft
    ["What is the Lite tier?", "视频档位"],
    ["Is Lite free for free users?", "视频档位"],
    ["The update popup won't close", "更新机制"],
    ["How do I zoom in on the canvas?", "工作流画布"],
  ])("检索（英文）：「%s」把「%s」那一节排进前 3", (q, heading) => {
    const r = rankOf(svc.selectKnowledge(q), heading);
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("检索（英文）：补词不拉偏 —— 删的 / 找回的不是段与草稿时不带「撤销」那一节，找回密码不带「取回」，有汉字的那一行不经过英文表", () => {
    for (const q of [
      "How do I delete my comment?",
      "I deleted a comment by mistake",
      "Can I recover a deleted comment?",
      "How do I delete a published video?",
      "Can I delete my account?",
    ]) {
      expect(svc.selectKnowledge(q)).not.toContain("删掉一段与撤销");
    }
    expect(svc.selectKnowledge("Can I recover my password?")).not.toContain("「取回」= 避免二次付费");
    expect(svc.selectKnowledge("Is the Pro version worth it?")).not.toContain("更新机制");
    // 中文问法夹着英文词：英文表一条都不生效，与把那几个英文词换成无关英文词的结果一字不差
    expect(svc.selectKnowledge("我想 refund，token 被 charged 了")).toBe(svc.selectKnowledge("我想 zzzz，token 被 qqqqqq 了"));
  });

  // ★ 英文虚词只从纯英文那一行里剥：第一版在 bigrams() 里两边一起剥，带汉字的问话也被剥，表里的「key」是知识库实词（§4.5「501 没配 key」、
  //   §4.8「未配 key」），这一问的对的那一节从前 3 掉到第 13（2026-10-20 复核抓到）。现在带汉字的问话与没有这张表时逐字节相同
  it("检索：英文虚词只从纯英文行里剥 —— 带汉字的问话一个英文词都不剥，纯英文问法多几个虚词结果不变", () => {
    expect(rankOf(svc.selectKnowledge("出片报错说没配 key 是怎么回事"), "生成失败的典型原因与文案")).toBeGreaterThanOrEqual(1);
    expect(rankOf(svc.selectKnowledge("出片报错说没配 key 是怎么回事"), "生成失败的典型原因与文案")).toBeLessThanOrEqual(3);
    expect(svc.selectKnowledge("How do I block someone? is it up to the")).toBe(svc.selectKnowledge("How do I block someone?"));
  });

  it("提示词：英文界面叫法对照表 —— lang=en 或 enNames（路由按这一轮原话判）时带上，中文一个字都不多；草稿档叫 Lite", () => {
    const en = svc.buildSupportSystemPrompt({ lang: "en", knowledge: "x" });
    expect(en).toContain("Recover（取回）");
    expect(en).toContain("Fast（极速）");
    expect(en).toContain("Refined（定妆，2.63 撤了）");
    expect(en).toContain("Lite（出片档位里的「草稿」");
    expect(en).not.toContain("Draft（");
    const zhEnTurn = svc.buildSupportSystemPrompt({ lang: "zh", enNames: true, knowledge: "x" });
    expect(zhEnTurn).toContain("【英文界面叫法】");
    expect(zhEnTurn).toContain("这一轮就用英文回答");
    const zh = svc.buildSupportSystemPrompt({ lang: "zh", knowledge: "x" });
    expect(zh).not.toContain("英文界面叫法");
    expect(zh).toContain("默认用中文回复；用户用英文就用英文。");
    expect(svc.isEnglishAsk("Where did the Refined tier go?")).toBe(true);
    expect(svc.isEnglishAsk("Refined 档去哪了")).toBe(false);
    expect(svc.isEnglishAsk("2.63？")).toBe(false);
    expect(svc.isEnglishAsk("")).toBe(false);
  });

  // ★ 中文问注销 / 删号 / 账号找回时不喂 §3.6「删掉一段与撤销」（2026-10-20 生产核对：那一节的「恢复 / 找回 / 删除」把它顶到第 2~5 名，
  //   模型可能把「6 秒内点撤销」说成注销也能撤回）。§2.6 照旧第 1；问删段 / 删草稿的不受影响（下一条）
  it.each([
    "注销了还能找回吗",
    "我想删号",
    "注销之后还能恢复吗",
    "注销账号之后还能恢复吗",
    "注销账号之后",
    "删号了还能找回吗",
    "账号删除了还能找回吗",
    "账号删了能恢复吗",
    "注销后还能撤回吗",
    "误注销了怎么恢复",
    "我要销号",
    "怎么找回账号",
  ])("检索：问注销 / 删号 / 找回账号「%s」不喂「删掉一段与撤销」", (q) => {
    expect(rankOf(svc.selectKnowledge(q), "删掉一段与撤销")).toBe(0);
  });

  it("检索：注销 / 删号那几问 §2.6 第 1（「我要销号」原来一节都没喂）；按标题认的那一节在知识库里还在", () => {
    for (const q of ["注销了还能找回吗", "我想删号", "注销之后还能恢复吗", "注销账号之后还能恢复吗", "注销账号之后", "我要销号", "账号删了能恢复吗"]) {
      expect(rankOf(svc.selectKnowledge(q), "注销账号")).toBe(1);
    }
    // 挡的那一节按标题里的一段字认：知识库重新生成改了这个名字，这里先红（不然注销那几问又悄悄喂进去）
    expect(svc.loadKnowledge().sections.filter((s) => s.title.includes("删掉一段与撤销"))).toHaveLength(1);
  });

  it("检索：问删段 / 删草稿的照旧（第 1 名不变），上一轮或这一轮说到段 / 草稿时不挡", () => {
    expect(rankOf(svc.selectKnowledge("我删了一段能撤回吗"), "删掉一段与撤销")).toBe(1);
    expect(rankOf(svc.selectKnowledge("删错了一段怎么恢复"), "删掉一段与撤销")).toBe(1);
    expect(rankOf(svc.selectKnowledge("how do I undo deleting a segment"), "删掉一段与撤销")).toBe(1);
    expect(rankOf(svc.selectKnowledge("草稿删了能恢复吗"), "草稿")).toBe(1);
    expect(rankOf(svc.selectKnowledge("删了一段能撤回吗\n那注销账号呢"), "删掉一段与撤销")).toBe(1);
    expect(rankOf(svc.selectKnowledge("注销账号\n那删掉的段呢"), "删掉一段与撤销")).toBeGreaterThanOrEqual(1);
    expect(rankOf(svc.selectKnowledge("注销前删掉的段能恢复吗"), "删掉一段与撤销")).toBeGreaterThanOrEqual(1);
  });

  // ★ 2026-10-20 复核：「不拦」原来只认中文的段 / 草稿 —— 中文问完注销、接着用英文问删段，§3.6 一节都不喂（main 上是第 1）
  it("检索：上一轮问注销、这一轮用英文问删段 / 删草稿，照旧喂「删掉一段与撤销」", () => {
    expect(rankOf(svc.selectKnowledge("怎么注销账号？\nhow do I undo deleting a segment"), "删掉一段与撤销")).toBe(1);
    expect(rankOf(svc.selectKnowledge("怎么注销账号？\nI deleted a segment by mistake, can I get it back"), "删掉一段与撤销")).toBeGreaterThanOrEqual(1);
    expect(rankOf(svc.selectKnowledge("注销账号\nCan I undo deleting a draft?"), "删掉一段与撤销")).toBeGreaterThanOrEqual(1);
    // 英文那一行与段 / 草稿无关时照旧挡
    expect(rankOf(svc.selectKnowledge("怎么注销账号？\nhow do I undo"), "删掉一段与撤销")).toBe(0);
  });

  // ★ 在 Google / GitHub 页面上点了取消（§2.10，2026-10-20 起回到 App）：原来「取消」不在那条同义词里，下面头两问 §2.10 只排第 4
  it.each([
    "我在谷歌登录页点了取消，现在怎么办",
    "谷歌登录取消了",
    "取消了谷歌登录怎么办",
    "我拒绝了 GitHub 的授权",
    "Google 那页我点了不同意",
  ])("检索：「%s」把 §2.10 排进前 3", (q) => {
    const r = rankOf(svc.selectKnowledge(q), "Google / GitHub 登录没登上");
    expect(r).toBeGreaterThanOrEqual(1);
    expect(r).toBeLessThanOrEqual(3);
  });

  it("检索：与 Google / GitHub 登录无关的「取消」不带 §2.10；买东西 / 装包的取消让开", () => {
    for (const q of ["取消订阅", "取消合成", "怎么取消关注", "怎么取消自动续费", "取消点赞", "谷歌商店取消订阅", "谷歌商店的会员怎么取消续费"]) {
      expect(rankOf(svc.selectKnowledge(q), "Google / GitHub 登录没登上")).toBe(0);
    }
    expect(rankOf(svc.selectKnowledge("Google Play 上的订阅怎么取消"), "充值订单")).toBe(1);
    expect(rankOf(svc.selectKnowledge("GitHub 下载到一半取消了"), "下载页")).toBe(1);
  });

  it("isEnglishAsk：只有真英文问法才算（至少两个实词）；短拉丁词、缩写、版本号不算", () => {
    for (const q of ["ok", "OK", "QQ", "UID", "APK", "VIP", "token", "HD", "hi", "thx", "2.63", "v2.63", "ok thx", "QQ UID", "token app", "Refund", "好的 ok"]) {
      expect([q, svc.isEnglishAsk(q)]).toEqual([q, false]);
    }
    for (const q of ["how do I undo", "I cancelled the Google sign-in, what now?", "merge failed", "Refund please", "thanks a lot", "where is my draft", "Is there an iOS app?"]) {
      expect([q, svc.isEnglishAsk(q)]).toEqual([q, true]);
    }
  });

  it("isEnglishAsk：链接、邮箱、带数字的串（任务号 / id / 版本 / 1080p）整块不算词；笑声不算", () => {
    const pasted = [
      "cgt-20251020150103-abx9z",
      "task id: cgt-20251020150103-qwert",
      "abc123@qq.com",
      "tliu@gmail.com",
      "https://ideahubs.org/download",
      "ideahubs.org",
      "www.ideahubs.org/privacy",
      "6712abcdef0123456789abcd",
      "hhhh hhhh",
      "hahaha hahaha",
      "hehe emmm",
    ];
    for (const q of pasted) expect([q, svc.isEnglishAsk(q)]).toEqual([q, false]);
    for (const q of ["Is 1080p free?", "mp4 file won't play", "v2.63 update failed", "merge failed.", "my email is abc@qq.com, please check", "can't merge"]) {
      expect([q, svc.isEnglishAsk(q)]).toEqual([q, true]);
    }
  });

  it("replyInEnglish：这一问没汉字又判不了时跟着上一问走；中文会话恒为否", () => {
    const zh = "出片一直没结果，钱扣了怎么取回？";
    const en = "My video never finished and I was charged. How do I get it back?";
    for (const q of ["ok", "QQ", "HD", "Refund", "cgt-20251020150103-abx9z", "abc123@qq.com", "1234567", "👍"]) {
      expect([q, svc.replyInEnglish([zh, q])]).toEqual([q, false]);
      expect([q, svc.replyInEnglish([en, q])]).toEqual([q, true]);
      expect([q, svc.replyInEnglish([q])]).toEqual([q, false]);
    }
    expect(svc.replyInEnglish([zh, "merge failed"])).toBe(true);
    expect(svc.replyInEnglish([en, "那要多久"])).toBe(false);
    expect(svc.replyInEnglish(["ok", "thx"])).toBe(false);
    expect(svc.replyInEnglish([])).toBe(false);
    expect(svc.replyInEnglish(undefined)).toBe(false);
  });

  it("检索：短拉丁词那一行照旧走英文表（判英文回复收紧了，检索没跟着收）", () => {
    // 「HD」这一行照旧补「高清 档位」：中文对话里追问一句 HD，要的正是视频档位那一节
    expect(rankOf(svc.selectKnowledge("HD"), "视频档位")).toBe(1);
    expect(svc.selectKnowledge("电影级档位为什么点不动？\nHD")).toContain("视频档位");
  });

  it("parseHandoff / categoryFromText", () => {
    expect(svc.parseHandoff("[handoff:account] 好的")).toMatchObject({ handoff: true, category: "account", text: "好的" });
    expect(svc.parseHandoff("[handoff:banana] 好的").category).toBe("other");
    expect(svc.parseHandoff("[HANDOFF] x").handoff).toBe(true);
    expect(svc.parseHandoff("正常").handoff).toBe(false);
    // 分隔符与 companion.parseTags 同一个口径：: ： = 都认，两边可以有空格（2026-10-20）
    expect(svc.parseHandoff("[handoff=billing] 好的")).toMatchObject({ handoff: true, category: "billing", reason: "", text: "好的" });
    expect(svc.parseHandoff("[handoff：billing] 好的")).toMatchObject({ handoff: true, category: "billing", text: "好的" });
    expect(svc.parseHandoff("[ handoff : account ] 好的")).toMatchObject({ handoff: true, category: "account", text: "好的" });
    expect(svc.parseHandoff("[handoff:billing:用户要退款] 好的")).toMatchObject({ category: "billing", reason: "用户要退款", text: "好的" });
    expect(svc.parseHandoff("[handoff=billing：要退款] 好的")).toMatchObject({ category: "billing", reason: "要退款", text: "好的" });
    expect(svc.parseHandoff("[handoff:用户要退款] 好的")).toMatchObject({ category: "other", reason: "用户要退款" });
    expect(svc.parseHandoff("[handoffs] 好的").handoff).toBe(false);
    expect(svc.stripHandoffTags("好的 [handoff=billing] 请点转人工 [ handoff：bug ]")).toBe("好的 请点转人工 ");
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
