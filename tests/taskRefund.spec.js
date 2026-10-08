// tests/taskRefund.spec.js
// 受理之后才失败的生成任务：按原桶退钱，恰好一次（2026-10-07 主人拍板「做生成失败返回 token」，services/taskRefund.service.js）。
//
// ★ 这里每一条守的都是**钱**，而且都是「拆掉也不报错」的那种：
//   ① 只认上游**明说**的失败（failed / cancelled / expired、MiniMax Fail）—— 404 / 504 / 读不懂 / 还在跑一律不退；
//   ② 恰好一次：两个轮询、清扫器、白模化取回同时看见也只退一次；崩在半截的按账本续办、不退第二次；
//   ③ 退给**账的主人**、按扣的那两桶原样退回；别人来问拿不到余额头与 refund 字段；
//   ④ 管理员免单与上线之前的老任务（没有账）不退；
//   ⑤ 钱不是在本人轮询里退的就发一条通知（只发一条）；退款抵掉当日用量；账本与余额对得上。
// ★ 不真的打方舟 / MiniMax：fetch 换成按地址分派的假上游。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const MINIMAX_CN = "https://api.minimaxi.com/v1";
const MINI = "doubao-seedance-2-0-mini-260615";

let mongod;
let app;
let User;
let TokenLedger;
let Notification;
let GenTaskCharge;
let ArkVideoTask;
let wallet;
let tokens;
let svc;
let fetchSpy;

/** 假上游的剧本（每条用例改它） */
let up;
let taskSeq = 0;

function resetUpstream() {
  up = {
    tasks: {}, // 方舟任务号 → { status, code, message } | "404" | "throw" | "html"
    mm: {}, // MiniMax 任务号 → status 字符串
    calls: [],
  };
}

function json(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch() {
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url, init = {}) => {
    const u = String(url);
    up.calls.push({ url: u, method: init.method || "GET" });
    if (u === `${ARK}/contents/generations/tasks` && (init.method || "GET") === "POST") {
      taskSeq += 1;
      return json(200, { id: `cgt-tr-${taskSeq}` });
    }
    if (u.startsWith(`${ARK}/contents/generations/tasks/`)) {
      const id = u.slice(u.lastIndexOf("/") + 1);
      const t = up.tasks[id];
      if (t === "404") return json(404, { error: { code: "ResourceNotFound" } });
      if (t === "throw") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (t === "html") return new Response("<html>oops</html>", { status: 200 });
      const st = t || { status: "running" };
      return json(200, { id, model: MINI, status: st.status, ...(st.code ? { error: { code: st.code, message: st.message || "失败了" } } : {}) });
    }
    if (u === `${MINIMAX_CN}/video_generation`) {
      taskSeq += 1;
      return json(200, { task_id: `mm-tr-${taskSeq}`, base_resp: { status_code: 0, status_msg: "success" } });
    }
    if (u.startsWith(`${MINIMAX_CN}/query/video_generation`)) {
      const id = new URL(u).searchParams.get("task_id");
      return json(200, { task_id: id, status: up.mm[id] || "Processing", base_resp: { status_code: 0, status_msg: "success" } });
    }
    throw new Error(`没有为这个地址准备回应：${u}`);
  });
}

let seq = 0;
async function makeUser({ admin = false, paid = false } = {}) {
  seq += 1;
  const name = `tr${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  const id = String(res.body.user._id);
  if (admin) await User.updateOne({ _id: id }, { $set: { role: "admin" } });
  await wallet.getWallet(id);
  if (paid) await wallet.credit(id, 3_000_000, "recharge", "测试充值");
  return { id, auth: { Authorization: `Bearer ${res.body.token}` } };
}

/** 草稿档（免费版能用）一段 4 秒 9:16：61,603 token */
const draftBody = () => ({ model: MINI, content: [{ type: "text", text: "雨夜街头" }], duration: 4, ratio: "9:16", resolution: "480p" });
const DRAFT_4S = 61_603;

async function createTask(u, body = draftBody()) {
  const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).send(body);
  if (res.status !== 200) throw new Error(`建任务没成：${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}
const poll = (u, id) => request(app).get(`/api/ark/contents/generations/tasks/${id}`).set(u.auth);
/** 方舟回的不是 JSON 时，代理原样透传（Content-Type 仍标 JSON）—— supertest 的 JSON 解析会抛，读原文 */
const pollRaw = (u, id) =>
  request(app)
    .get(`/api/ark/contents/generations/tasks/${id}`)
    .set(u.auth)
    .buffer(true)
    .parse((res, cb) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => cb(null, d));
    });
const total = (w) => w.plan + w.addon;
const memoOf = (provider, id) => `provider_failed ${provider} task:${id}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  Notification = require("../src/models/Notification");
  GenTaskCharge = require("../src/models/GenTaskCharge");
  ArkVideoTask = require("../src/models/ArkVideoTask");
  wallet = require("../src/services/tokenWallet.service");
  tokens = require("../src/config/tokens");
  svc = require("../src/services/taskRefund.service");
  await GenTaskCharge.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  process.env.ARK_API_KEY = "test-key-not-real";
  resetUpstream();
  installFetch();
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ARK_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_REGION;
  delete process.env.MINIMAX_FAIL_REFUND;
});

describe("受理时记账", () => {
  test("草稿档受理 → 一行 open 的账：实扣、从哪两桶扣的（plan 2,000 先扣光、其余 addon）", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    const row = await GenTaskCharge.findOne({ provider: "ark", taskId: id }).lean();
    expect(row).toMatchObject({ kind: "video", state: "open", charged: DRAFT_4S, free: false, model: MINI });
    expect(row.took).toEqual({ plan: 2_000, addon: DRAFT_4S - 2_000 });
    expect(String(row.user)).toBe(u.id);
    expect(row.memo).toMatch(new RegExp(`task ${MINI}`));
    expect(row.purgeAt).toBeUndefined(); // open 的行绝不挂 TTL
    expect(new Date(row.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  test("Seed3D 记成 3d、样片第一步记成 draft", async () => {
    const u = await makeUser({ paid: true });
    const id3d = await createTask(u, { model: "doubao-seed3d-2-0-260328", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] });
    expect((await GenTaskCharge.findOne({ taskId: id3d }).lean()).kind).toBe("3d");
    const idDraft = await createTask(u, { model: tokens.SEEDANCE_2_5, content: [{ type: "text", text: "x" }], duration: 4, ratio: "9:16", resolution: "480p", draft: true });
    expect((await GenTaskCharge.findOne({ taskId: idDraft }).lean()).kind).toBe("draft");
  });

  test("管理员免单：记成 skipped（没有要退的，不占清扫器的查询）", async () => {
    const a = await makeUser({ admin: true });
    const id = await createTask(a);
    const row = await GenTaskCharge.findOne({ taskId: id }).lean();
    expect(row).toMatchObject({ state: "skipped", note: "free", charged: 0, free: true });
    expect(row.purgeAt).toBeTruthy();
  });

  test("记账永不抛：同一个任务号重放、回读那一下也出错 → 回 null 并吼（不把受理了的那一发打成 5xx）", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(GenTaskCharge, "findOne").mockReturnValueOnce({ lean: () => Promise.reject(new Error("db blip")) });
    await expect(
      svc.recordCharge({ provider: "ark", taskId: id, kind: "video", user: u.id, model: MINI, cost: DRAFT_4S, took: { plan: 0, addon: DRAFT_4S } }),
    ).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    // 原来那一行账原样还在（重放不改它）
    expect((await GenTaskCharge.countDocuments({ provider: "ark", taskId: id }))).toBe(1);
  });
});

describe("轮询看见失败 → 按原桶退回，恰好一次", () => {
  test("failed：余额两桶各自复原、一行 provider_failed、响应带 refund 与余额头、不发通知", async () => {
    const u = await makeUser();
    const w0 = await wallet.getWallet(u.id);
    const id = await createTask(u);
    up.tasks[id] = { status: "failed", code: "OutputVideoSensitiveContentDetected" };
    const res = await poll(u, id).expect(200);
    expect(res.body.status).toBe("failed"); // 方舟的原话照回
    expect(res.body.refund).toEqual({ state: "refunded", tokens: DRAFT_4S });
    const w1 = await wallet.getWallet(u.id);
    expect({ plan: w1.plan, addon: w1.addon }).toEqual({ plan: w0.plan, addon: w0.addon }); // 原桶：plan 回 plan、addon 回 addon
    expect(Number(res.headers["x-wallet-plan"])).toBe(w0.plan);
    expect(Number(res.headers["x-wallet-addon"])).toBe(w0.addon);
    const rows = await TokenLedger.find({ user: u.id, reason: "provider_failed" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ delta: DRAFT_4S, memo: memoOf("ark", id) });
    const row = await GenTaskCharge.findOne({ taskId: id }).lean();
    expect(row).toMatchObject({ state: "refunded", refundedTokens: DRAFT_4S, upstreamStatus: "failed", upstreamCode: "OutputVideoSensitiveContentDetected", notified: true });
    expect(row.purgeAt).toBeTruthy();
    expect(await Notification.countDocuments({ userId: u.id, type: "GEN_TASK_REFUND" })).toBe(0);
    // 再轮询一次：照实说已经退了，不再退
    const again = await poll(u, id).expect(200);
    expect(again.body.refund).toEqual({ state: "refunded", tokens: DRAFT_4S });
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(1);
  });

  test("cancelled 与 expired 也退", async () => {
    const u = await makeUser();
    const w0 = await wallet.getWallet(u.id);
    const a = await createTask(u);
    const b = await createTask(u);
    up.tasks[a] = { status: "cancelled" };
    up.tasks[b] = { status: "expired" };
    expect((await poll(u, a)).body.refund).toMatchObject({ state: "refunded" });
    expect((await poll(u, b)).body.refund).toMatchObject({ state: "refunded" });
    expect(total(await wallet.getWallet(u.id))).toBe(total(w0));
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(2);
  });

  test("两个并发轮询 + 清扫器同时看见失败：只退一次", async () => {
    const u = await makeUser();
    const w0 = await wallet.getWallet(u.id);
    const id = await createTask(u);
    up.tasks[id] = { status: "failed" };
    await GenTaskCharge.updateOne({ taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    await Promise.all([poll(u, id), poll(u, id), svc.sweepTaskRefunds(), poll(u, id)]);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(1);
    expect(total(await wallet.getWallet(u.id))).toBe(total(w0));
  });

  test("别人轮询我的失败任务：退给我；他的响应里没有 refund、没有余额头；我收到一条通知（只一条）", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const w0 = await wallet.getWallet(owner.id);
    const o0 = await wallet.getWallet(other.id);
    const id = await createTask(owner);
    up.tasks[id] = { status: "failed" };
    const res = await poll(other, id).expect(200);
    expect(res.body.refund).toBeUndefined();
    expect(res.headers["x-wallet-plan"]).toBeUndefined();
    expect(total(await wallet.getWallet(owner.id))).toBe(total(w0));
    expect(total(await wallet.getWallet(other.id))).toBe(total(o0));
    const notes = await Notification.find({ userId: owner.id, type: "GEN_TASK_REFUND" }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toEqual({ tokens: DRAFT_4S, kind: "video", taskId: id, provider: "ark" });
    expect(notes[0].actorId).toBeFalsy(); // 平台口径：不带是谁
    // 清扫器补收尾：不会再发第二条
    await svc.finishFollowUps({ now: new Date(Date.now() + 5 * 60_000) });
    expect(await Notification.countDocuments({ userId: owner.id, type: "GEN_TASK_REFUND" })).toBe(1);
  });

  test("管理员免单的任务失败：不退（没扣钱），refund 说 skipped", async () => {
    const a = await makeUser({ admin: true });
    const id = await createTask(a);
    up.tasks[id] = { status: "failed" };
    const res = await poll(a, id).expect(200);
    expect(res.body.refund).toEqual({ state: "skipped", tokens: 0 });
    expect(await TokenLedger.countDocuments({ user: a.id, reason: "provider_failed" })).toBe(0);
  });

  test("上线之前的老任务（没有账）：不退、不带 refund（不知道扣了多少、从哪两桶扣的）", async () => {
    const u = await makeUser();
    up.tasks["cgt-legacy-1"] = { status: "failed" };
    const res = await poll(u, "cgt-legacy-1").expect(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.refund).toBeUndefined();
    expect(await TokenLedger.countDocuments({ reason: "provider_failed", memo: memoOf("ark", "cgt-legacy-1") })).toBe(0);
  });

  test("成功 → 记成 settled（钱照收），之后方舟就算再说别的也不退", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    up.tasks[id] = { status: "succeeded" };
    const res = await poll(u, id).expect(200);
    expect(res.body.refund).toBeUndefined();
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("settled");
    up.tasks[id] = { status: "failed" };
    await poll(u, id).expect(200);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(0);
  });
});

describe("没问到 ≠ 失败：这些一律不退", () => {
  test.each([
    ["还在跑", { status: "running" }],
    ["排队中", { status: "queued" }],
    ["认不出的状态", { status: "weird_new_state" }],
    ["方舟 404", "404"],
    ["上游超时（我们回 504）", "throw"],
    ["回包不是 JSON", "html"],
  ])("%s → 不退、账还是 open", async (_label, script) => {
    const u = await makeUser();
    const id = await createTask(u);
    up.tasks[id] = script;
    await pollRaw(u, id);
    const row = await GenTaskCharge.findOne({ taskId: id }).lean();
    expect(row.state).toBe("open");
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(0);
    // 清扫器问到同样的东西：也不退，只往后退避
    await GenTaskCharge.updateOne({ taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    await svc.reconcile();
    const after = await GenTaskCharge.findOne({ taskId: id }).lean();
    expect(after.state).toBe("open");
    expect(after.checks).toBe(1);
    expect(new Date(after.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(0);
  });

  test("结账那一步出错（查库抖了）：轮询照样回方舟的原话，不是 500；账还是 open，清扫器之后能退", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    up.tasks[id] = { status: "failed" };
    const spy = jest.spyOn(GenTaskCharge, "findOneAndUpdate").mockImplementationOnce(() => {
      throw new Error("db hiccup");
    });
    const res = await poll(u, id).expect(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.refund).toBeUndefined();
    spy.mockRestore();
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("open");
    await GenTaskCharge.updateOne({ taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    await svc.sweepTaskRefunds();
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("refunded");
  });
});

describe("清扫器", () => {
  test("没人再来问的失败任务：清扫器问上游、退钱、发一条通知；没到点的不问", async () => {
    const u = await makeUser();
    const w0 = await wallet.getWallet(u.id);
    const due = await createTask(u);
    const fresh = await createTask(u);
    up.tasks[due] = { status: "failed" };
    up.tasks[fresh] = { status: "failed" };
    await GenTaskCharge.updateOne({ taskId: due }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    up.calls = [];
    const out = await svc.sweepTaskRefunds();
    expect(out.settled).toBe(1);
    expect(up.calls.filter((c) => c.url.endsWith(fresh))).toHaveLength(0); // 受理 10 分钟内的不问
    expect((await GenTaskCharge.findOne({ taskId: due }).lean()).state).toBe("refunded");
    expect((await GenTaskCharge.findOne({ taskId: fresh }).lean()).state).toBe("open");
    expect(total(await wallet.getWallet(u.id))).toBe(total(w0) - DRAFT_4S);
    expect(await Notification.countDocuments({ userId: u.id, type: "GEN_TASK_REFUND", "payload.taskId": due })).toBe(1);
  });

  test("同一个实例不重入：上一轮还没跑完，下一轮直接回 running", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const u = await makeUser();
    const id = await createTask(u);
    await GenTaskCharge.updateOne({ taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    const first = svc.sweepTaskRefunds({ query: async () => (await gate, null) });
    const second = await svc.sweepTaskRefunds({ query: async () => null });
    expect(second).toEqual({ running: true });
    release();
    expect((await first).checked).toBe(1);
  });

  test("8 天都问不出结局：记成 lost（带 purgeAt）并吼，不退", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    await GenTaskCharge.collection.updateOne({ taskId: id }, { $set: { createdAt: new Date(Date.now() - 8 * 24 * 3600_000 - 1000), nextCheckAt: new Date(Date.now() - 1000) } });
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const out = await svc.reconcile();
    expect(out.lost).toBe(1);
    const row = await GenTaskCharge.findOne({ taskId: id }).lean();
    expect(row).toMatchObject({ state: "lost", note: "too_old" });
    expect(row.purgeAt).toBeTruthy();
    expect(err.mock.calls.some((c) => String(c[0]).includes("8 天"))).toBe(true);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(0);
  });

  test("崩在「抢到」与「标退完」之间：续办时先问账本 —— 没进过账就退一次，进过就只补标记", async () => {
    const u = await makeUser();
    const w0 = await wallet.getWallet(u.id);
    const a = await createTask(u);
    const b = await createTask(u);
    const old = new Date(Date.now() - 10 * 60_000);
    // a：抢到了，钱没退就崩了
    await GenTaskCharge.updateOne({ taskId: a }, { $set: { state: "claimed", claimedAt: old } });
    // b：抢到了，钱退了（账本有那一行），没来得及标 refunded 就崩了
    await GenTaskCharge.updateOne({ taskId: b }, { $set: { state: "claimed", claimedAt: old } });
    const rowB = await GenTaskCharge.findOne({ taskId: b }).lean();
    await wallet.refundSplit(u.id, rowB.took, "provider_failed", memoOf("ark", b));
    // 两个续办方同时来（再抢一次 claimedAt）：每一笔都只办一次
    await Promise.all([svc.resumeClaimed(), svc.resumeClaimed()]);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed", memo: memoOf("ark", a) })).toBe(1);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed", memo: memoOf("ark", b) })).toBe(1);
    expect((await GenTaskCharge.findOne({ taskId: a }).lean()).state).toBe("refunded");
    expect((await GenTaskCharge.findOne({ taskId: b }).lean()).state).toBe("refunded");
    expect(total(await wallet.getWallet(u.id))).toBe(total(w0));
  });

  test("通知第一次没发出去：收尾标记放回，下一轮清扫器补发（只补一次）", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    up.tasks[id] = { status: "failed" };
    // taskRefund 在模块加载时解构了 createNotification —— 让它失败要从 Notification.create 下手
    const create = jest.spyOn(Notification, "create").mockImplementationOnce(async () => {
      throw new Error("mongo down");
    });
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await GenTaskCharge.updateOne({ taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    await svc.sweepTaskRefunds();
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).notified).toBe(false);
    create.mockRestore();
    err.mockRestore();
    await svc.finishFollowUps({ now: new Date(Date.now() + 5 * 60_000) });
    await svc.finishFollowUps({ now: new Date(Date.now() + 10 * 60_000) });
    expect(await Notification.countDocuments({ userId: u.id, type: "GEN_TASK_REFUND" })).toBe(1);
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).notified).toBe(true);
  });
});

describe("账与上限", () => {
  test("退款抵掉当日用量（provider_failed 在 SPEND_REASONS 里 —— 它不是 refundTag，billing.spec 那条扫不到）", async () => {
    expect(wallet.SPEND_REASONS).toContain("provider_failed");
    expect(require("../src/models/TokenLedger").TOKEN_REASONS).toContain("provider_failed");
    const u = await makeUser();
    const id = await createTask(u);
    expect(await wallet.spentToday(u.id)).toBe(DRAFT_4S);
    up.tasks[id] = { status: "failed" };
    await poll(u, id);
    expect(await wallet.spentToday(u.id)).toBe(0);
  });

  test("退款不抵欠额（退的是我们的钱，不是他付的）", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.debt": 5_000 } });
    up.tasks[id] = { status: "failed" };
    await poll(u, id);
    const w = await wallet.getWallet(u.id);
    expect(w.debt).toBe(5_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "debt_repaid" })).toBe(0);
  });

  test("流水逐笔累加 ≡ 余额（grant + 两次扣 + 一次失败退款）", async () => {
    const u = await makeUser();
    const a = await createTask(u);
    await createTask(u);
    up.tasks[a] = { status: "failed" };
    await poll(u, a);
    const rows = await TokenLedger.find({ user: u.id }).lean();
    expect(rows.reduce((n, r) => n + r.delta, 0)).toBe(total(await wallet.getWallet(u.id)));
  });
});

describe("给 App 的两个出口", () => {
  test("GET /api/ark/task-charges/:id：只给账的主人；别人 404", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const id = await createTask(owner);
    const r0 = await request(app).get(`/api/ark/task-charges/${id}`).set(owner.auth).expect(200);
    expect(r0.body).toMatchObject({ ok: true, taskId: id, provider: "ark", kind: "video", state: "pending", tokens: DRAFT_4S });
    await request(app).get(`/api/ark/task-charges/${id}`).set(other.auth).expect(404);
    await request(app).get(`/api/ark/task-charges/bad$id`).set(owner.auth).expect(400);
    up.tasks[id] = { status: "failed" };
    await poll(other, id); // 别人的轮询替我退了
    const r1 = await request(app).get(`/api/ark/task-charges/${id}`).set(owner.auth).expect(200);
    expect(r1.body).toMatchObject({ state: "refunded", tokens: DRAFT_4S });
  });

  test("GET /api/ark/video-tasks 不列已经退了钱的（没有成片可取了）", async () => {
    const u = await makeUser();
    const a = await createTask(u);
    const b = await createTask(u);
    up.tasks[a] = { status: "failed" };
    await poll(u, a);
    const res = await request(app).get("/api/ark/video-tasks").set(u.auth).expect(200);
    const ids = res.body.tasks.map((t) => t.taskId);
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
    expect(await ArkVideoTask.countDocuments({ taskId: a })).toBe(1); // 登记本身还在（取件 / 样片要用），只是不列
  });
});

describe("MiniMax（真人档）", () => {
  async function mmCreate(u) {
    const res = await request(app)
      .post("/api/minimax/video")
      .set(u.auth)
      .send({ model: "MiniMax-Hailuo-2.3-Fast", prompt: "p", duration: 6, first_frame_image: "data:image/png;base64,QQ==" });
    expect(res.status).toBe(200);
    return res.body.task_id;
  }
  const mmPoll = (u, id) => request(app).get(`/api/minimax/video/${id}`).set(u.auth);

  test("受理记账（带区域）；轮询看见 Fail → 退一次；Success → settled", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    const u = await makeUser({ paid: true });
    const w0 = await wallet.getWallet(u.id);
    const id = await mmCreate(u);
    const row = await GenTaskCharge.findOne({ provider: "minimax", taskId: id }).lean();
    expect(row).toMatchObject({ kind: "minimax", region: "cn", charged: 85_000, state: "open" });
    up.mm[id] = "Fail";
    const res = await mmPoll(u, id).expect(200);
    expect(res.body.status).toBe("Fail");
    expect(res.body.refund).toEqual({ state: "refunded", tokens: 85_000 });
    await mmPoll(u, id).expect(200);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed", memo: memoOf("minimax", id) })).toBe(1);
    expect(total(await wallet.getWallet(u.id))).toBe(total(w0));

    const ok = await mmCreate(u);
    up.mm[ok] = "Success";
    await mmPoll(u, ok).expect(200);
    expect((await GenTaskCharge.findOne({ provider: "minimax", taskId: ok }).lean()).state).toBe("settled");
  });

  test("开关 MINIMAX_FAIL_REFUND=off：Fail 不退，账留 open（开关打开之后还能接着退）", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    const u = await makeUser({ paid: true });
    const id = await mmCreate(u);
    process.env.MINIMAX_FAIL_REFUND = "off";
    up.mm[id] = "Fail";
    const res = await mmPoll(u, id).expect(200);
    expect(res.body.refund).toEqual({ state: "pending", tokens: 85_000 });
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(0);
    delete process.env.MINIMAX_FAIL_REFUND;
    await mmPoll(u, id).expect(200);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(1);
  });

  test("清扫器只回同一个站去问：区域被切走了就不问（拿另一把 key 去问只会查无此任务，那不是结局）", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    const u = await makeUser({ paid: true });
    const id = await mmCreate(u);
    up.mm[id] = "Fail";
    await GenTaskCharge.updateOne({ provider: "minimax", taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000), region: "intl" } });
    up.calls = [];
    await svc.reconcile();
    expect(up.calls.filter((c) => c.url.includes("query/video_generation"))).toHaveLength(0);
    expect((await GenTaskCharge.findOne({ provider: "minimax", taskId: id }).lean()).state).toBe("open");
    // 区域对得上时：清扫器问到 Fail 就退
    await GenTaskCharge.updateOne({ provider: "minimax", taskId: id }, { $set: { nextCheckAt: new Date(Date.now() - 1000), region: "cn" } });
    await svc.reconcile();
    expect((await GenTaskCharge.findOne({ provider: "minimax", taskId: id }).lean()).state).toBe("refunded");
  });
});

describe("账号没了", () => {
  test("退款时账号已经不在：记 skipped（user_gone），不留一行永远办不完的 claimed", async () => {
    const u = await makeUser();
    const id = await createTask(u);
    await User.deleteOne({ _id: u.id });
    up.tasks[id] = { status: "failed" };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const row = await svc.settleTask({ provider: "ark", taskId: id, status: "failed" });
    warn.mockRestore();
    expect(row).toMatchObject({ state: "skipped", note: "user_gone" });
  });
});
