// tests/gameTicket.spec.js
// 「工坊游戏券」（GameTicket，2026-11-23）—— 设计正本在 app 仓 docs/g2-game-ui.md §7 与
// docs/g4-ui-revamp-spec.md §0（免费套餐每月 6 张、券只用于游戏内出片、不扣 token）。
//
// 覆盖：月度懒发与幂等、grant 的幂等与日上限、spend 的原子性（并发两发不能扣成负）、refund、
// GET /api/game/tickets、POST /api/game/tickets/grant（仅管理员）、/api/ark/health 的能力位、
// 带券出片**不扣 token**、券不足的 NO_GAME_TICKET、免费账号在 H3 上带图的放开（只对带券生效）、
// 未受理 / 受理后失败两种退券、券只用于出片（出图带标记直接拒）、管理员免单优先于券。
//
// ★ 不花钱、不出网：fetch 换成间谍，按 URL 回假的上游回包；「扣没扣 token」由钱包与账本断言。
// ★ 这一组判据错了都**零症状**，所以每一条都有反例：
//   · 月度券不幂等 → 每读一次余额多 6 张（无限出片）；
//   · spend 读-改-写 → 两张并发请求都通过，余额扣成 -1；
//   · 券那一发照抄 token 报价记账 → 失败时按 token 退（券变成钱包里的钱）；
//   · 带券标记悄悄走 token → 用户点了「用一张券」，钱却被扣了；
//   · 免费账号带图不认券 → 工坊默认档（H3-Lite 480P）一张券也花不出去：挂卡出片全线 403。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let wallet;
let gameTicket;
let taskRefund;
let User;
let GameTicket;
let GameTicketGrant;
let GenTaskCharge;
let TokenLedger;
let cloudinary;
let savedCloud;
let fetchSpy;
let calls;
/** 方舟那一发怎么回（每条用例可以换） */
let arkReply;

const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const V2 = "https://api.minimax.io/v2";
const CN = "https://api.minimaxi.com/v1";
const CLOUD = "testcloud";
const MINI = "doubao-seedance-2-0-mini-260615"; // 草稿 480p（免费档）
const LITE = "MiniMax-H3-Lite";
const HS = "MiniMax-H3-Highspeed";
const REAL = "MiniMax-Hailuo-2.3";

const ENV_KEYS = ["GAME_TICKETS", "ARK_API_KEY", "MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY", "MINIMAX_REGION", "VIDEO_REGION_GATE", "VIDEO_ZONE_FORCE", "FREE_VIDEO_GATE"];
let savedEnv;

const resp = (status, obj) => ({ status, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) });
const ourImg = (name = "a") => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/ideahub/content-images/${name}.jpg`;
const text = (t = "海边，女孩回头一笑") => ({ type: "text", text: t });
const img = (role = "reference_image", url = ourImg()) => ({ type: "image_url", image_url: { url }, role });

/** 一段 Seedance 草稿 480p · 5 秒（免费档能出，77,004 token） */
const seedanceBody = (o = {}) => ({ model: MINI, resolution: "480p", duration: 5, ratio: "9:16", content: [text()], ...o });
/** 一段 H3-Lite · 480P · 5 秒的纯文字（免费档；带图要付过钱，或者带券） */
const liteBody = (o = {}) => ({ model: LITE, resolution: "480P", duration: 5, ratio: "9:16", content: [text()], ...o });
/** 带一张参考图的 H3-Lite（工坊对局里「挂卡出片」的形状：文字 + 卡面图） */
const liteWithCard = (o = {}) => liteBody({ content: [text(), img("reference_image")], ...o });

const cycleOf = (n = new Date()) => `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;

let seq = 0;
/**
 * 建一个账号。缺省 = 免费套餐（不充值、不买套餐），也就是「没有付过钱」的那一批人 —— 券主要就是给他们的。
 * @param {string} tag
 * @param {{topUp?:number, paid?:boolean}} [o] topUp 给了就往钱包里塞 token（测「带券不扣 token」时要一个非零余额）
 */
async function registerUser(tag, { topUp = 0 } = {}) {
  seq += 1;
  const name = `gt_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  const id = res.body.user._id;
  if (topUp > 0) {
    await wallet.getWallet(id); // 先把钱包建出来（新人额度），再摆余额
    await User.updateOne({ _id: id }, { $set: { "tokenWallet.plan": topUp, "tokenWallet.addon": 0, "tokenWallet.debt": 0 } });
  }
  return { id, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const walletTotal = async (id) => {
  const w = await wallet.getWallet(id);
  return w.plan + w.addon;
};

const ticketRow = (id) => GameTicket.findOne({ userId: id }).lean();
const grantCount = () => GameTicketGrant.countDocuments({});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  wallet = require("../src/services/tokenWallet.service");
  gameTicket = require("../src/services/gameTicket.service");
  taskRefund = require("../src/services/taskRefund.service");
  User = require("../src/models/User");
  GameTicket = require("../src/models/GameTicket");
  GameTicketGrant = require("../src/models/GameTicketGrant");
  GenTaskCharge = require("../src/models/GenTaskCharge");
  TokenLedger = require("../src/models/TokenLedger");
  cloudinary = require("../src/config/cloudinary").cloudinary;
  savedCloud = cloudinary.config().cloud_name;
  cloudinary.config({ cloud_name: CLOUD });
  await Promise.all([GameTicket.createIndexes(), GameTicketGrant.createIndexes(), GenTaskCharge.createIndexes()]);
});

afterAll(async () => {
  cloudinary.config({ cloud_name: savedCloud });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await GameTicket.deleteMany({});
  await GameTicketGrant.deleteMany({});
  await GenTaskCharge.deleteMany({});
  await TokenLedger.deleteMany({});
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // 缺省：方舟配着、MiniMax 只配国际站（V2 开着）、地区门禁 observe、券开着
  process.env.ARK_API_KEY = "ark-test-not-real";
  process.env.MINIMAX_INTL_API_KEY = "mm-intl-test-not-real";
  calls = [];
  arkReply = () => resp(200, { id: "cgt-task-1" });
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", body: init.body });
    if (u.startsWith(ARK)) return arkReply(u, init);
    if (u === `${V2}/video_generation`) return resp(200, { task_id: "100000000000001" });
    if (u === `${CN}/video_generation`) return resp(200, { task_id: 42, base_resp: { status_code: 0 } });
    throw new Error(`测试里没有为这个地址准备回应：${u}`);
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("月度券：懒发 6 张 + 幂等 + 余额形状", () => {
  test("第一次读余额就发当月 6 张；再读一次**不多发**（唯一键 (userId, monthly, YYYY-MM) 是锁）", async () => {
    const u = await registerUser("monthly");
    const a = await gameTicket.balance(u.id);
    expect(a).toMatchObject({ cycle: cycleOf(), limit: 6, granted: 6, earned: 0, spent: 0, refunded: 0, used: 0, left: 6, perGeneration: 1 });
    // 换一个月看下次重置：下个月 1 日 00:00:00 UTC
    const reset = new Date(a.nextResetAt);
    expect(reset.getUTCDate()).toBe(1);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(Date.now());

    const b = await gameTicket.balance(u.id);
    expect(b.left).toBe(6);
    expect(b.granted).toBe(6);
    expect(await grantCount()).toBe(1); // 只落了一条 monthly 流水
  });

  test("并发读两次余额也只发一次（两个 pm2 实例同时懒发）", async () => {
    const u = await registerUser("monthly-race");
    const [a, b] = await Promise.all([gameTicket.balance(u.id), gameTicket.balance(u.id)]);
    expect(a.left).toBe(6);
    expect(b.left).toBe(6);
    const row = await ticketRow(u.id);
    expect(row.granted).toBe(6);
    expect(row.balance).toBe(6);
    expect(await GameTicketGrant.countDocuments({ userId: u.id, source: "monthly" })).toBe(1);
  });

  test("跨月：上个月那一行不动，新月另发 6 张（懒发，没有定时任务）", async () => {
    const u = await registerUser("cross-month");
    const now = new Date("2026-11-15T10:00:00Z");
    const nov = await gameTicket.balance(u.id, now);
    expect(nov.cycle).toBe("2026-11");
    // 花掉两张
    await gameTicket.spend({ userId: u.id, now });
    await gameTicket.spend({ userId: u.id, now });
    expect((await gameTicket.balance(u.id, now)).left).toBe(4);
    // 十二月：新的一行、6 张；十一月那一行还在、还是 4 张
    const dec = await gameTicket.balance(u.id, new Date("2026-12-02T00:00:05Z"));
    expect(dec).toMatchObject({ cycle: "2026-12", granted: 6, left: 6, spent: 0 });
    const novRow = await GameTicket.findOne({ userId: u.id, cycle: "2026-11" }).lean();
    expect(novRow.balance).toBe(4);
    expect(novRow.spent).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("grant：幂等（同一个 refId 只发一次）+ 日上限 + source 名单", () => {
  test("同一个 refId 发两次只到账一次；第二次回 duplicate", async () => {
    const u = await registerUser("grant-idem");
    await gameTicket.balance(u.id); // 6
    const one = await gameTicket.grant({ userId: u.id, source: "share", refId: "evt-1", count: 1, memo: "分享" });
    expect(one.granted).toBe(true);
    expect(one.ticket.left).toBe(7);
    const two = await gameTicket.grant({ userId: u.id, source: "share", refId: "evt-1", count: 1 });
    expect(two.granted).toBe(false);
    expect(two.reason).toBe("duplicate");
    expect((await gameTicket.balance(u.id)).left).toBe(7);
    expect((await ticketRow(u.id)).earned).toBe(1);
  });

  test("并发发同一笔也只到账一次（唯一索引是那把锁）", async () => {
    const u = await registerUser("grant-race");
    await gameTicket.balance(u.id);
    const results = await Promise.all([
      gameTicket.grant({ userId: u.id, source: "invite", refId: "evt-r", count: 1 }),
      gameTicket.grant({ userId: u.id, source: "invite", refId: "evt-r", count: 1 }),
      gameTicket.grant({ userId: u.id, source: "invite", refId: "evt-r", count: 1 }),
    ]);
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect((await gameTicket.balance(u.id)).left).toBe(7);
  });

  test("不同 source 的同一个 refId 是两笔（唯一键是三元组）", async () => {
    const u = await registerUser("grant-src");
    await gameTicket.balance(u.id);
    expect((await gameTicket.grant({ userId: u.id, source: "share", refId: "same", count: 1 })).granted).toBe(true);
    expect((await gameTicket.grant({ userId: u.id, source: "invite", refId: "same", count: 1 })).granted).toBe(true);
    expect((await gameTicket.balance(u.id)).left).toBe(8);
  });

  test("任务加券的日上限（TASK_GRANTS_PER_DAY=5）：第 6 张拒、monthly / admin 不受它管", async () => {
    const u = await registerUser("grant-cap");
    await gameTicket.balance(u.id);
    for (let i = 1; i <= 5; i += 1) {
      expect((await gameTicket.grant({ userId: u.id, source: "share", refId: `d-${i}`, count: 1 })).granted).toBe(true);
    }
    const sixth = await gameTicket.grant({ userId: u.id, source: "share", refId: "d-6", count: 1 });
    expect(sixth.granted).toBe(false);
    expect(sixth.reason).toBe("day_cap");
    // admin 那条不受日上限管（人工补发）
    expect((await gameTicket.grant({ userId: u.id, source: "admin", count: 2 })).granted).toBe(true);
    expect((await gameTicket.balance(u.id)).left).toBe(6 + 5 + 2);
  });

  test("source 不在名单 / count 非法 → 拒且一分不发；关着（GAME_TICKETS=off）也拒", async () => {
    const u = await registerUser("grant-bad");
    await gameTicket.balance(u.id);
    expect(await gameTicket.grant({ userId: u.id, source: "refund", refId: "x", count: 1 })).toMatchObject({ granted: false, reason: "bad_source" });
    expect(await gameTicket.grant({ userId: u.id, source: "admin", count: 0 })).toMatchObject({ granted: false, reason: "bad_count" });
    expect(await gameTicket.grant({ userId: u.id, source: "admin", count: 11 })).toMatchObject({ granted: false, reason: "bad_count" });
    process.env.GAME_TICKETS = "off";
    expect(await gameTicket.grant({ userId: u.id, source: "admin", count: 1 })).toMatchObject({ granted: false, reason: "disabled" });
    delete process.env.GAME_TICKETS;
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("spend：原子扣一张（并发两发不能扣成负）", () => {
  test("余额 1 张时两发并发只扣得成一次，余额到 0 不为负", async () => {
    const u = await registerUser("spend-race");
    await gameTicket.balance(u.id); // 6
    // 摆成「只剩 1 张」（spent 记 5）
    await GameTicket.updateOne({ userId: u.id }, { $set: { granted: 6, earned: 0, balance: 1, spent: 5, refunded: 0 } });
    const [a, b] = await Promise.all([gameTicket.spend({ userId: u.id }), gameTicket.spend({ userId: u.id })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const row = await ticketRow(u.id);
    expect(row.balance).toBe(0);
    expect(row.spent).toBe(6);
    expect(row.balance).toBeGreaterThanOrEqual(0);
  });

  test("一张都没有 → ok:false reason:empty（调用方回 NO_GAME_TICKET）", async () => {
    const u = await registerUser("spend-empty");
    await GameTicket.create({ userId: u.id, cycle: cycleOf(), granted: 6, earned: 0, spent: 6, refunded: 0, balance: 0 });
    expect(await gameTicket.spend({ userId: u.id })).toMatchObject({ ok: false, reason: "empty" });
  });

  test("第一次花券时把当月那 6 张补上（懒发不能只活在 GET 那条路上）", async () => {
    const u = await registerUser("spend-lazy");
    const r = await gameTicket.spend({ userId: u.id });
    expect(r.ok).toBe(true);
    expect(r.ticket.left).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("refund：退回一张 + 幂等（同一个 provider:taskId 只退一次）", () => {
  test("花掉一张再退回来；票数回到 6、spent 与 refunded 各记一次（used 是净用了 0）", async () => {
    const u = await registerUser("refund");
    await gameTicket.balance(u.id);
    await gameTicket.spend({ userId: u.id });
    expect((await gameTicket.balance(u.id)).left).toBe(5);
    const r = await gameTicket.refund({ userId: u.id, refId: "ark:cgt-1", memo: "失败" });
    expect(r.applied).toBe(true);
    const t = await gameTicket.balance(u.id);
    expect(t).toMatchObject({ left: 6, spent: 1, refunded: 1, used: 0 });
    // 幂等：同一次退款再来一遍不多退
    const again = await gameTicket.refund({ userId: u.id, refId: "ark:cgt-1" });
    expect(again).toMatchObject({ applied: false, duplicate: true });
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });

  test("退券不走 token 账本、也不动钱包余额（券与 token 不可互换）", async () => {
    const u = await registerUser("refund-ledger", { topUp: 100_000 });
    await gameTicket.spend({ userId: u.id });
    const before = await walletTotal(u.id);
    const ledgerBefore = await TokenLedger.countDocuments({ user: u.id });
    await gameTicket.refund({ userId: u.id, refId: "ark:cgt-2" });
    expect(await walletTotal(u.id)).toBe(before);
    expect(await TokenLedger.countDocuments({ user: u.id })).toBe(ledgerBefore);
  });

  test("账号没了 → 退不回去（回 applied:false，不凭空造一行余额）", async () => {
    const u = await registerUser("refund-gone");
    await gameTicket.balance(u.id);
    await User.deleteOne({ _id: u.id });
    await GameTicket.deleteMany({ userId: u.id });
    const r = await gameTicket.refund({ userId: u.id, refId: "ark:cgt-3" });
    expect(r.applied).toBe(false);
    expect(await GameTicket.countDocuments({ userId: u.id })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("GET /api/game/tickets", () => {
  test("余额 + 本月已用 / 上限 + 下次重置；未登录 401", async () => {
    const u = await registerUser("api-get");
    const res = await request(app).get("/api/game/tickets").set(u.auth).expect(200);
    expect(res.body).toMatchObject({ ok: true, cycle: cycleOf(), limit: 6, granted: 6, left: 6, used: 0, perGeneration: 1, enabled: true });
    expect(res.body.nextResetAt).toBe(gameTicket.nextResetAt().toISOString());
    await request(app).get("/api/game/tickets").expect(401);
  });

  test("花掉一张之后 used=1、left=5（App 只显示服务端下发的数）", async () => {
    const u = await registerUser("api-get2");
    await gameTicket.spend({ userId: u.id });
    const res = await request(app).get("/api/game/tickets").set(u.auth).expect(200);
    expect(res.body).toMatchObject({ left: 5, used: 1, spent: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("POST /api/game/tickets/grant（仅管理员）", () => {
  test("普通用户 → 403（券是平台印钱：开放给任何登录用户 = 自己给自己发券）", async () => {
    const u = await registerUser("grant-api-user");
    const res = await request(app).post("/api/game/tickets/grant").set(u.auth).send({ source: "admin", count: 1 });
    expect(res.status).toBe(403);
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });

  test("管理员发给别人：201；同一个 refId 再来一次 → 200 duplicate、余额不变", async () => {
    const admin = await registerUser("grant-api-admin");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const target = await registerUser("grant-api-target");
    const first = await request(app)
      .post("/api/game/tickets/grant")
      .set(admin.auth)
      .send({ userId: target.id, source: "invite", refId: "inv-1", count: 2, memo: "邀请" })
      .expect(201);
    expect(first.body).toMatchObject({ ok: true, granted: true, count: 2 });
    expect((await gameTicket.balance(target.id)).left).toBe(8);
    const second = await request(app)
      .post("/api/game/tickets/grant")
      .set(admin.auth)
      .send({ userId: target.id, source: "invite", refId: "inv-1", count: 2 })
      .expect(200);
    expect(second.body).toMatchObject({ ok: true, granted: false, duplicate: true });
    expect((await gameTicket.balance(target.id)).left).toBe(8);
  });

  test("参数不对：share 缺 refId → 400 REF_ID_REQUIRED；source 不认 → 400 BAD_SOURCE；count 超上限 → 400 BAD_COUNT", async () => {
    const admin = await registerUser("grant-api-admin2");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    expect((await request(app).post("/api/game/tickets/grant").set(admin.auth).send({ source: "share" })).body).toMatchObject({ code: "REF_ID_REQUIRED" });
    expect((await request(app).post("/api/game/tickets/grant").set(admin.auth).send({ source: "refund" })).body).toMatchObject({ code: "BAD_SOURCE" });
    expect((await request(app).post("/api/game/tickets/grant").set(admin.auth).send({ source: "admin", count: 99 })).body).toMatchObject({ code: "BAD_COUNT" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("/api/ark/health 的能力位 + 急停开关", () => {
  test("gameTickets / gameTicketMonthly / gameTicketPerGeneration / gameTicketUnlocksMedia 都在", async () => {
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body).toMatchObject({ gameTickets: true, gameTicketMonthly: 6, gameTicketPerGeneration: 1, gameTicketUnlocksMedia: true });
    expect(JSON.stringify(h.body)).not.toMatch(/mm-intl-test|ark-test/); // 不泄露 key
  });

  test("GAME_TICKETS=off：能力位 false；带券标记出片 → 403 GAME_TICKETS_OFF（**不静默改走 token**）", async () => {
    process.env.GAME_TICKETS = "off";
    const u = await registerUser("off", { topUp: 500_000 });
    const before = await walletTotal(u.id);
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body).toMatchObject({ gameTickets: false, gameTicketUnlocksMedia: false });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set("X-Game-Ticket", "1").send(seedanceBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("GAME_TICKETS_OFF");
    expect(calls).toHaveLength(0); // 没出网
    expect(await walletTotal(u.id)).toBe(before); // 一分钱没扣
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("出片按券结算：扣一张券、不扣 token（/api/ark 出片）", () => {
  test("带券 → 200、券 6→5、**token 余额一分不动**、账本里没有 ark_spend、任务账记 currency:ticket / charged:1", async () => {
    const u = await registerUser("pay-ark", { topUp: 500_000 });
    const before = await walletTotal(u.id);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set("X-Game-Ticket", "1").send(seedanceBody()).expect(200);
    expect(res.body).toMatchObject({ id: "cgt-task-1" });
    expect(await walletTotal(u.id)).toBe(before); // ★ 关键：一个 token 都没扣
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "ark_spend" })).toBe(0);
    expect((await gameTicket.balance(u.id)).left).toBe(5);

    const row = await GenTaskCharge.findOne({ provider: "ark", taskId: "cgt-task-1" }).lean();
    expect(row).toMatchObject({ charged: 1, currency: "ticket", state: "open" });
    expect(row.took).toEqual({ plan: 0, addon: 0 });
    // 转发给方舟的那一份里没有任何券的私货
    const sent = JSON.parse(calls[calls.length - 1].body);
    expect(sent).not.toHaveProperty("payWithTicket");
    expect(sent).not.toHaveProperty("X-Game-Ticket");
  });

  test("不带标记 → 走原来的 token 钱包（默认行为不变）：扣 77,004、券一张不动", async () => {
    const u = await registerUser("pay-token", { topUp: 500_000 });
    const before = await walletTotal(u.id);
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).send(seedanceBody()).expect(200);
    expect(await walletTotal(u.id)).toBe(before - 77_004);
    expect((await gameTicket.balance(u.id)).left).toBe(6); // 券没动
    const row = await GenTaskCharge.findOne({ provider: "ark", taskId: "cgt-task-1" }).lean();
    expect(row).toMatchObject({ charged: 77_004, currency: "token" });
  });

  test("请求体里的 payWithTicket:true 同样生效（会先被删掉再转发，不会撞上方舟的参数）", async () => {
    const u = await registerUser("pay-body");
    const before = await walletTotal(u.id);
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).send(seedanceBody({ payWithTicket: true })).expect(200);
    expect(await walletTotal(u.id)).toBe(before);
    expect((await gameTicket.balance(u.id)).left).toBe(5);
    const sent = JSON.parse(calls[calls.length - 1].body);
    expect(sent).not.toHaveProperty("payWithTicket");
  });

  test("券只用于出片：出图带标记 → 400 TICKET_NOT_APPLICABLE，不出网、不扣券也不扣钱", async () => {
    const u = await registerUser("pay-image", { topUp: 500_000 });
    const { IMAGE_MODELS } = require("../src/config/tokens");
    const model = IMAGE_MODELS[0];
    const before = await walletTotal(u.id);
    const res = await request(app).post("/api/ark/images/generations").set(u.auth).set("X-Game-Ticket", "1").send({ model, prompt: "一只猫" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TICKET_NOT_APPLICABLE");
    expect(calls).toHaveLength(0);
    expect(await walletTotal(u.id)).toBe(before);
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("券不足：403 NO_GAME_TICKET（不是 402 —— 券买不到）", () => {
  test("一张不剩 → 403 NO_GAME_TICKET、不出网、token 与券都不动", async () => {
    const u = await registerUser("no-ticket", { topUp: 500_000 });
    await GameTicket.create({ userId: u.id, cycle: cycleOf(), granted: 6, earned: 0, spent: 6, refunded: 0, balance: 0 });
    const before = await walletTotal(u.id);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set("X-Game-Ticket", "1").send(seedanceBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: "NO_GAME_TICKET", need: 1, left: 0 });
    expect(res.body.nextResetAt).toBe(gameTicket.nextResetAt().toISOString());
    expect(calls).toHaveLength(0);
    expect(await walletTotal(u.id)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("免费账号带图：带券的 H3-Lite 放行，不带的照旧 403（券 ≠ 会员）", () => {
  test("没付过钱的账号带参考图出 H3-Lite：不带券 → 403 freeTextOnly；带券 → 200、券 6→5", async () => {
    const u = await registerUser("h3-media");
    const denied = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteWithCard());
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "PLAN_REQUIRED", freeTextOnly: true });
    expect(calls).toHaveLength(0);
    expect((await gameTicket.balance(u.id)).left).toBe(6); // 被拒的那一发没动券

    const ok = await request(app).post("/api/minimax/v2/video").set(u.auth).set("X-Game-Ticket", "1").send(liteWithCard());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, task_id: "100000000000001" });
    expect((await gameTicket.balance(u.id)).left).toBe(5);
    // 记账记成券，不记 token 报价
    const row = await GenTaskCharge.findOne({ provider: "minimax", taskId: "100000000000001" }).lean();
    expect(row).toMatchObject({ charged: 1, currency: "ticket", api: "v2" });
  });

  test("券不等于会员：带券点 H3（768P，付费档）仍然 403 PLAN_REQUIRED，且**不扣券**", async () => {
    const u = await registerUser("h3-paid-tier");
    const res = await request(app)
      .post("/api/minimax/v2/video")
      .set(u.auth)
      .set("X-Game-Ticket", "1")
      .send({ model: HS, resolution: "768P", duration: 5, ratio: "16:9", content: [text()] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(res.body).not.toHaveProperty("freeTextOnly"); // 拒的是档位，不是带图
    expect(calls).toHaveLength(0);
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });

  test("纯文字带券照常（放开带图不等于只准带图）", async () => {
    const u = await registerUser("h3-text");
    await request(app).post("/api/minimax/v2/video").set(u.auth).set("X-Game-Ticket", "1").send(liteBody()).expect(200);
    expect((await gameTicket.balance(u.id)).left).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("失败退券：两种失败各走各的退法", () => {
  test("上游没受理（400）→ 券当场退回、token 不动、不留任务账", async () => {
    const u = await registerUser("refund-unaccepted", { topUp: 500_000 });
    arkReply = () => resp(400, { error: { code: "SensitiveContentDetected", message: "input sensitive" } });
    const before = await walletTotal(u.id);
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set("X-Game-Ticket", "1").send(seedanceBody()).expect(400);
    expect((await gameTicket.balance(u.id)).left).toBe(6); // 退回来了
    expect(await walletTotal(u.id)).toBe(before);
    expect(await GenTaskCharge.countDocuments({ user: u.id })).toBe(0);
  });

  test("受理之后上游才说 failed → 清扫器那一拍把券退回（taskRefund 按 currency 退券、不退 token）", async () => {
    const u = await registerUser("refund-failed", { topUp: 500_000 });
    await gameTicket.spend({ userId: u.id });
    expect((await gameTicket.balance(u.id)).left).toBe(5);
    await taskRefund.recordCharge({
      provider: "ark",
      taskId: "cgt-failed-1",
      kind: "video",
      user: u.id,
      model: MINI,
      cost: 1,
      currency: "ticket",
      took: { plan: 0, addon: 0 },
    });
    const row = await GenTaskCharge.findOne({ taskId: "cgt-failed-1" }).lean();
    expect(row).toMatchObject({ charged: 1, currency: "ticket", state: "open" });

    const ledgerBefore = await TokenLedger.countDocuments({ user: u.id });
    const walletBefore = await walletTotal(u.id);
    const settled = await taskRefund.settleTask({ provider: "ark", taskId: "cgt-failed-1", status: "failed", viewerId: u.id });
    expect(settled).toMatchObject({ state: "refunded", refundedTokens: 1 });
    expect((await gameTicket.balance(u.id)).left).toBe(6);
    // 退的是券，不是 token：钱包与 token 账本都不动
    expect(await walletTotal(u.id)).toBe(walletBefore);
    expect(await TokenLedger.countDocuments({ user: u.id })).toBe(ledgerBefore);
    // 幂等：再结一次不会多退
    await taskRefund.settleTask({ provider: "ark", taskId: "cgt-failed-1", status: "failed", viewerId: u.id });
    expect((await gameTicket.balance(u.id)).left).toBe(6);
    // 给客户端的「钱怎么样了」说清楚：0 token、1 张券
    expect(taskRefund.refundView(settled)).toEqual({ state: "refunded", tokens: 0, tickets: 1, currency: "ticket" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("管理员：免单优先于券（顺序写在这里，也别处写）", () => {
  test("管理员带券出片：200、券一张不扣、落一笔 admin_free（costTokens 记报价）", async () => {
    const admin = await registerUser("admin-free", { topUp: 500_000 });
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const before = await walletTotal(admin.id);
    await request(app).post("/api/ark/contents/generations/tasks").set(admin.auth).set("X-Game-Ticket", "1").send(seedanceBody()).expect(200);
    expect(await walletTotal(admin.id)).toBe(before); // 免单：token 不动
    expect((await gameTicket.balance(admin.id)).left).toBe(6); // 券也不动
    const free = await TokenLedger.findOne({ user: admin.id, reason: "admin_free" }).lean();
    expect(free).toMatchObject({ delta: 0, costTokens: 77_004 });
    // 免单那一发不产生可退的账（charged 0 → skipped）
    const row = await GenTaskCharge.findOne({ provider: "ark", taskId: "cgt-task-1" }).lean();
    expect(row).toMatchObject({ charged: 0, free: true, state: "skipped" });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MiniMax 真人档（v1）也认券", () => {
  test("配了中国站 + 付费账号（真人档本来只给付费用户）：带券 → 200、券 6→5、token 不动、账记 minimax / ticket", async () => {
    delete process.env.MINIMAX_INTL_API_KEY;
    process.env.MINIMAX_API_KEY = "mm-cn-test-not-real";
    const u = await registerUser("pay-mm", { topUp: 500_000 });
    // ★ 真人档对没付过钱的人本来就不开（videoPlanDenial）：券不是会员，所以这里必须先是付费账号
    await wallet.buyPlan(u.id, "std");
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 500_000, "tokenWallet.addon": 0 } });
    const before = await walletTotal(u.id);
    const body = { model: REAL, prompt: "海边", duration: 6, resolution: "768P" };
    await request(app).post("/api/minimax/video").set(u.auth).set("X-Game-Ticket", "1").send(body).expect(200);
    expect(await walletTotal(u.id)).toBe(before);
    expect((await gameTicket.balance(u.id)).left).toBe(5);
    const row = await GenTaskCharge.findOne({ provider: "minimax", taskId: "42" }).lean();
    expect(row).toMatchObject({ charged: 1, currency: "ticket", kind: "minimax" });
  });

  test("免费账号带券点真人档 → 403 PLAN_REQUIRED、不扣券（券 ≠ 会员，这一条对三条出片路都成立）", async () => {
    delete process.env.MINIMAX_INTL_API_KEY;
    process.env.MINIMAX_API_KEY = "mm-cn-test-not-real";
    const u = await registerUser("pay-mm-free");
    const res = await request(app)
      .post("/api/minimax/video")
      .set(u.auth)
      .set("X-Game-Ticket", "1")
      .send({ model: REAL, prompt: "海边", duration: 6, resolution: "768P" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(calls).toHaveLength(0);
    expect((await gameTicket.balance(u.id)).left).toBe(6);
  });
});
