/**
 * 老师人格的钱（tutor 仓 docs/05 §6.2）：一轮教学开流前扣 tutor_turn=400，第一个 token 之前上游抛 → 退回（tutor_refund 进账本）；
 * 生成受理即扣整份报价；蒸馏扣 tutor_distill。aiClient 用 jest.mock 换成脚本：只测钱的序列与 SSE 形状，不测网络。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const pages = require("./fixtures/tutor/week1-delay.pages.json");

let streamMode = "ok"; // ok | failBeforeFirst
jest.mock("../src/services/aiClient", () => {
  const actual = jest.requireActual("../src/services/aiClient");
  return {
    ...actual,
    hasAiKey: () => true,
    aiComplete: async (prompt, opts = {}) => {
      const text = (opts.messages || []).map((m) => m.content).join("\n") + String(prompt || "");
      if (/判卷老师/.test(text)) { const n = (text.match(/第 \d+ 题/g) || []).length; return { text: JSON.stringify({ results: Array.from({ length: n }, () => ({ correct: true, why: "对" })) }), model: "mock", finishReason: "stop", usage: { promptTokens: 50, completionTokens: 10 } }; }
      if (/只输出合规的 op|op_catalog|ops/.test(text)) return { text: JSON.stringify({ ops: [{ op: "profile.preference.add", path: "/profile/preferences", value: "喜欢举例", evidence: [1], rationale: "test" }] }), model: "mock", finishReason: "stop", usage: { promptTokens: 200, completionTokens: 30 } };
      // 生成那三种提示词：形状不对就退回演示规则（pipeline 自己会），这里给一个空对象让它走「两次都没拿到」→ 演示兜底
      return { text: "{}", model: "mock", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2 } };
    },
    aiChatStream: async function* (messages, opts = {}) {
      if (streamMode === "failBeforeFirst") { const e = new Error("upstream 502"); e.status = 502; throw e; }
      for (const c of ["先算一道。", "你手上有几个数？"]) { await new Promise((r) => setTimeout(r, 5)); yield c; }
      if (opts.onFinish) opts.onFinish("stop", "mock");
      if (opts.onUsage) opts.onUsage({ model: "mock", promptTokens: 300, completionTokens: 20, cacheHitTokens: 0, cacheMissTokens: 300, reasoningTokens: 0 });
    },
  };
});

let mongod;
let app;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.TUTOR_ENABLED = "true";
  process.env.AI_API_KEY = "k";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});
afterAll(async () => { await mongoose.disconnect(); if (mongod) await mongod.stop(); });

async function createUser(prefix = "tb") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const balance = async (uid) => { const w = await require("../src/services/tokenWallet.service").getWallet(uid); return w.plan + w.addon; };

describe("tutor 计费", () => {
  jest.setTimeout(60_000);
  it("教学轮：开流前扣 400、成功不退；第一个 token 前上游抛 → 退回并记 tutor_refund；生成受理即扣报价；蒸馏扣 600", async () => {
    const { user, token } = await createUser();
    const wallet = require("../src/services/tokenWallet.service");
    await wallet.ensureWallet(user._id);
    const b0 = await balance(user._id);
    // 建课 + 直接塞教材（不走 Cloudinary）
    const cid = (await request(app).post("/api/tutor/courses").set(auth(token)).send({ title: "网络", subject: "计算机网络", policy: { ai: "limited", homework_mode: "principles_only", text: "" } })).body.course.id;
    const { CourseCtx } = require("../src/services/tutorStore.service");
    const ctx = await CourseCtx.load(cid, user);
    await ctx.addMaterial({ name: "w.pdf", sha: "d".repeat(64), ext: "pdf", bytes: 1, pages, license: { source: "self" }, warnings: [] });
    // 生成：报价 = tutor_extract × (1 份教材 + N 节 + 1)，受理那一拍扣掉
    const quote = (await request(app).get(`/api/tutor/courses/${cid}/quote`).set(auth(token))).body;
    expect(quote.demo).toBe(false);
    expect(quote.quote.total).toBe(400 * (1 + quote.stages + 1));
    const gen = await request(app).post("/api/tutor/personas/generate").set(auth(token)).send({ courseId: cid, questionnaire: { name: "老包" } });
    expect(gen.status).toBe(202);
    expect(gen.headers["x-wallet-plan"]).toBeDefined();
    expect(b0 - (await balance(user._id))).toBe(quote.quote.total);
    const job = await require("../src/services/tutorAi.service").runNextJob();
    expect(job.status).toBe("succeeded");
    expect(job.failures.length).toBeGreaterThan(0); // 模型给的 {} 不合形状 → 每块按演示规则兜底，且当面记「已计费」
    const b1 = await balance(user._id);
    // 一轮教学：扣 400，流里有 token / sentence / done
    const bundle = (await request(app).get(`/api/tutor/runs/${cid}`).set(auth(token))).body;
    const s1 = bundle.doc.map.stages[0].stage_id;
    const turn = await request(app).post(`/api/tutor/runs/${cid}/turns`).set(auth(token)).send({ kind: "ask", stage: s1, text: "为什么？" });
    expect(turn.status).toBe(200);
    expect(turn.headers["x-wallet-plan"]).toBeDefined();
    expect(turn.text).toMatch(/event: done/);
    expect(turn.text).toMatch(/先算一道/);
    expect(b1 - (await balance(user._id))).toBe(400);
    const done = JSON.parse([...turn.text.matchAll(/event: done\ndata: (.*)\n/g)].at(-1)[1]);
    expect(done.demo).toBe(false);
    // 试教同价
    const b2 = await balance(user._id);
    expect((await request(app).post(`/api/tutor/personas/${cid}/preview`).set(auth(token)).send({ kind: "teach" })).text).toMatch(/event: done/);
    expect(b2 - (await balance(user._id))).toBe(400);
    // 第一个 token 之前上游抛：SSE 里是 error 事件、钱退回、账本有 tutor_refund
    streamMode = "failBeforeFirst";
    const b3 = await balance(user._id);
    const failed = await request(app).post(`/api/tutor/runs/${cid}/turns`).set(auth(token)).send({ kind: "ask", stage: s1, text: "再问" });
    streamMode = "ok";
    expect(failed.status).toBe(200);
    expect(failed.text).toMatch(/event: error/);
    expect(failed.text).toMatch(/已退回/);
    expect(await balance(user._id)).toBe(b3);
    const TokenLedger = require("../src/models/TokenLedger");
    expect(await TokenLedger.countDocuments({ user: user._id, reason: "tutor_refund" })).toBe(1);
    // 账本：turn / preview 各一条实测 usage
    const ledger = (await request(app).get("/api/tutor/usage-ledger").set(auth(token))).body;
    expect(ledger.summary.byKind.turn.calls).toBeGreaterThanOrEqual(2);
    expect(ledger.summary.byKind.preview.calls).toBe(1);
    expect(ledger.summary.byKind.turn.total.p50).toBe(320);
    // 蒸馏：手动整理一次扣 600
    const b4 = await balance(user._id);
    const dist = await request(app).post(`/api/tutor/runs/${cid}/distill`).set(auth(token)).send({});
    expect(dist.status).toBe(200);
    expect(dist.body.status).toBe("done");
    expect(b4 - (await balance(user._id))).toBe(600);
    expect(dist.body.revision.ops[0]).toMatchObject({ op: "profile.preference.add", status: "applied" });
    // 余额不够：402，一分不扣、不开流
    await wallet.revokeTokens({ userId: user._id, amount: await balance(user._id), memo: "test", isTest: true }).catch(() => {});
    const poor = await request(app).post(`/api/tutor/runs/${cid}/turns`).set(auth(token)).send({ kind: "ask", stage: s1, text: "没钱" });
    expect([402, 403]).toContain(poor.status);
    expect(poor.body.ok).toBe(false);
  });
});
