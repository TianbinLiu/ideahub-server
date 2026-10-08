// tests/freeQuota.spec.js
// 免费额度（2026-10-07 主人拍板）：新人一次 170,000 + 每天 2,000（最多攒 7 天 = 14,000），付费套餐照旧按月刷新；
// 以及「付没付过钱」（tokenWallet.paidEver）—— 免费档门禁（config/tokens.isPaidUser）认的就是它。
//
// ★ 这几条都是「做错了不报错、只会悄悄多发或少发」的形状：
//   ① 新人额度只能发一次（并发首次触达、老钱包都不能再发）；
//   ② 每日补发按 UTC 日抢占，只补不削（老账号剩下的月度额度不能被一把削没）；
//   ③ 付费套餐不吃每日补发、免费版不吃月度刷新（否则攒了几天的额度跨月一把清零）；
//   ④ 付过钱的标记由支付入账置真、老账号按**订单**回填一次（退过款的、测试购买、老的模拟充值都不算），
//      回收之后按订单重算（tokenWallet.refreshPaidEver）；GET /api/me/wallet 回 `paid` 与 `free`。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;
let TokenLedger;
let TokenOrder;
let wallet;
let tokens;

const WELCOME = 170_000;
const DAILY = 2_000;
const CAP = 14_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  TokenOrder = require("../src/models/TokenOrder");
  wallet = require("../src/services/tokenWallet.service");
  tokens = require("../src/config/tokens");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function makeUser() {
  seq += 1;
  const name = `fq${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, id: String(res.body.user._id), auth: { Authorization: `Bearer ${res.body.token}` } };
}

/** 某一天的 UTC 正午（拨时钟用：ensureWallet 收 now） */
const dayAt = (iso) => new Date(`${iso}T12:00:00Z`);

describe("免费版的额度形状与 app 一致（跨仓口径，数在 payOrder.spec 里逐条钉）", () => {
  test("PLANS.free：月额度 0、新人 170,000、每天 2,000、上限 14,000（= 7 天）", () => {
    expect(tokens.planOf("free")).toMatchObject({ price: 0, monthlyTokens: 0, welcomeTokens: WELCOME, dailyTokens: DAILY, dailyCapTokens: CAP });
    expect(CAP / DAILY).toBe(7);
  });
});

describe("新人额度：只发一次", () => {
  test("第一次触达：addon 170,000（不过期）+ plan 2,000（今天那一份），一行 grant 流水", async () => {
    const u = await makeUser();
    const w = await wallet.getWallet(u.id, dayAt("2026-10-07"));
    expect(w).toMatchObject({ plan: DAILY, addon: WELCOME, planId: "free", day: "2026-10-07", paidEver: false });
    const rows = await TokenLedger.find({ user: u.id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "grant", delta: WELCOME + DAILY, balanceAfter: WELCOME + DAILY });
    expect(rows[0].memo).toMatch(/新人额度/);
  });

  test("并发首次触达也只发一次", async () => {
    const u = await makeUser();
    await Promise.all(Array.from({ length: 8 }, () => wallet.getWallet(u.id)));
    const w = await wallet.getWallet(u.id);
    expect(w.plan + w.addon).toBe(WELCOME + DAILY);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "grant" })).toBe(1);
  });

  test("已有钱包的老账号不补发新人额度（他们已经拿过改版前那份）", async () => {
    const u = await makeUser();
    // 一个改版前的老钱包：没有 day、没有 paidEver，plan 里还剩 120,000 的月度额度
    await User.updateOne({ _id: u.id }, { $set: { tokenWallet: { plan: 120_000, addon: 0, planId: "free", cycle: "2026-10", debt: 0, debtSince: null } } });
    const w = await wallet.getWallet(u.id, dayAt("2026-10-07"));
    expect(w.addon).toBe(0); // 没有新人额度
    expect(w.plan).toBe(120_000); // 剩下的月度额度原样留着（每日补发只补不削）
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "grant" })).toBe(0);
  });
});

describe("每日额度：按 UTC 日补、补到上限为止、只补不削", () => {
  test("隔一天补 2,000；同一天再读不补；一行 daily_grant 流水", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.debit(u.id, DAILY, "花掉今天那一份", dayAt("2026-10-07"));
    const w = await wallet.getWallet(u.id, dayAt("2026-10-08"));
    expect(w.plan).toBe(DAILY);
    expect(w.day).toBe("2026-10-08");
    await wallet.getWallet(u.id, dayAt("2026-10-08"));
    expect((await wallet.getWallet(u.id, dayAt("2026-10-08"))).plan).toBe(DAILY);
    const rows = await TokenLedger.find({ user: u.id, reason: "daily_grant" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(DAILY);
  });

  test("隔了三天：补三天的量（攒着）", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.debit(u.id, DAILY, "花掉", dayAt("2026-10-07"));
    expect((await wallet.getWallet(u.id, dayAt("2026-10-10"))).plan).toBe(3 * DAILY);
  });

  test("攒到 14,000 为止：隔了 30 天也只有 14,000", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    expect((await wallet.getWallet(u.id, dayAt("2026-11-06"))).plan).toBe(CAP);
    // 再隔一天：已经在上限，不补也不记流水
    const before = await TokenLedger.countDocuments({ user: u.id, reason: "daily_grant" });
    expect((await wallet.getWallet(u.id, dayAt("2026-11-07"))).plan).toBe(CAP);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "daily_grant" })).toBe(before);
  });

  test("只补不削：plan 已经高于上限（老账号剩下的月度额度 / 失败退回 plan 的钱）原样留着", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 50_000 } });
    expect((await wallet.getWallet(u.id, dayAt("2026-10-09"))).plan).toBe(50_000);
    // 差一点到上限：只补到上限
    await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 13_000 } });
    expect((await wallet.getWallet(u.id, dayAt("2026-10-11"))).plan).toBe(CAP);
  });

  test("并发触达同一个新的一天：只补一次", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.debit(u.id, DAILY, "花掉", dayAt("2026-10-07"));
    await Promise.all(Array.from({ length: 8 }, () => wallet.getWallet(u.id, dayAt("2026-10-08"))));
    expect((await wallet.getWallet(u.id, dayAt("2026-10-08"))).plan).toBe(DAILY);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "daily_grant" })).toBe(1);
  });

  test("免费版跨月不刷新（刷新会把攒的那点额度一把清零，免费版月额度是 0）", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-30"));
    const w = await wallet.getWallet(u.id, dayAt("2026-11-02"));
    expect(w.plan).toBe(DAILY + 3 * DAILY);
    expect(w.cycle).toBe("2026-11");
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "cycle_reset" })).toBe(0);
  });

  test("流水与余额对得上（grant + daily_grant + 消费）", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.debit(u.id, 30_000, "消费", dayAt("2026-10-07"));
    await wallet.getWallet(u.id, dayAt("2026-10-12"));
    const rows = await TokenLedger.find({ user: u.id }).lean();
    const w = await wallet.getWallet(u.id, dayAt("2026-10-12"));
    expect(rows.reduce((n, r) => n + r.delta, 0)).toBe(w.plan + w.addon);
  });
});

describe("付费套餐不吃每日补发，照旧按月刷新", () => {
  test("std：隔几天不补；跨月归位到 1,660,000", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.buyPlan(u.id, "std", dayAt("2026-10-07"));
    await wallet.debit(u.id, 1_000_000, "消费", dayAt("2026-10-07"));
    const mid = await wallet.getWallet(u.id, dayAt("2026-10-12"));
    expect(mid.plan).toBe(DAILY + 1_660_000 - 1_000_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "daily_grant" })).toBe(0);
    const next = await wallet.getWallet(u.id, dayAt("2026-11-01"));
    expect(next.plan).toBe(1_660_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "cycle_reset" })).toBe(1);
  });

  test("拿一个旧的 now 来问（清扫器开轮那一拍）：不往回刷到上个月", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id, dayAt("2026-10-07"));
    await wallet.buyPlan(u.id, "std", dayAt("2026-10-07"));
    await wallet.getWallet(u.id, dayAt("2026-11-01"));
    await wallet.debit(u.id, 500_000, "新月里花掉", dayAt("2026-11-01"));
    const stale = await wallet.getWallet(u.id, new Date("2026-10-31T23:59:50Z"));
    expect(stale.cycle).toBe("2026-11");
    expect(stale.plan).toBe(1_660_000 - 500_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "cycle_reset" })).toBe(1);
  });
});

describe("付没付过钱（paidEver）", () => {
  test("充值（recharge）置真：同一次原子更新，套餐还是免费版也算付费用户", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id);
    const w = await wallet.credit(u.id, 200_000, "recharge", "订单 X");
    expect(w.paidEver).toBe(true);
    expect(w.planId).toBe("free");
    expect(tokens.isPaidUser(w)).toBe(true);
  });

  test("买套餐（plan_buy）置真", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id);
    const w = await wallet.buyPlan(u.id, "pro");
    expect(w.paidEver).toBe(true);
  });

  test("我们印的钱不置真：退款 / 同款奖励 / 每日补发", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id);
    await wallet.credit(u.id, 1_000, "ark_refund", "退");
    await wallet.credit(u.id, 30_000, "remix_reward", "奖");
    await wallet.refundSplit(u.id, { plan: 100, addon: 100 }, "provider_failed", "退");
    const w = await wallet.getWallet(u.id);
    expect(w.paidEver).toBe(false);
    expect(tokens.isPaidUser(w)).toBe(false);
  });

  /** 一张订单（只填 hasLivePayment 看的那几格） */
  let orderSeq = 0;
  const seedOrder = (userId, extra = {}) => {
    orderSeq += 1;
    return TokenOrder.create({ orderNo: `FQ${Date.now().toString(36)}${orderSeq}`, user: userId, kind: "recharge", packTokens: 200_000, amountFen: 600, status: "settled", settledAt: new Date(), ...extra });
  };

  test("老钱包（没有 paidEver）按**订单**回填一次：有还作数的付款 → true；没付过 / 退过款 / 测试购买 / 只有老模拟充值的账本 → false", async () => {
    // ★★ 2026-10-07 评审：原来按账本（recharge / plan_buy 流水）回填 —— 账本记不了「后来被退款了」，
    //   买一包、退款，付费档就永远对他开着；下单系统之前「调一下就到账」的模拟充值也在账本里留了 recharge。
    const paid = await makeUser();
    const never = await makeUser();
    const refunded = await makeUser();
    const tester = await makeUser();
    const legacyMock = await makeUser();
    for (const u of [paid, never, refunded, tester, legacyMock]) {
      await User.updateOne({ _id: u.id }, { $set: { tokenWallet: { plan: 1_000, addon: 0, planId: "free", cycle: "2026-10", day: "2026-10-07", debt: 0, debtSince: null } } });
    }
    await seedOrder(paid.id);
    await seedOrder(refunded.id, { channel: "play", status: "refunded", revokedAt: new Date() });
    await seedOrder(tester.id, { channel: "play", isTest: true });
    await TokenLedger.create({ user: legacyMock.id, delta: 200_000, reason: "recharge", balanceAfter: 201_000, memo: "老的模拟充值（没有订单）" });
    expect((await wallet.getWallet(paid.id, dayAt("2026-10-07"))).paidEver).toBe(true);
    for (const u of [never, refunded, tester, legacyMock]) expect((await wallet.getWallet(u.id, dayAt("2026-10-07"))).paidEver).toBe(false);
    // 写下来了：之后不再查订单
    const raw = await User.findById(never.id).select("tokenWallet").lean();
    expect(raw.tokenWallet.paidEver).toBe(false);
  });

  test("Play 测试购买（许可测试员，一分钱没付）照常入账，但不置「付过钱」", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id);
    const w = await wallet.credit(u.id, 150_000, "recharge", "Play 订单 T（测试购买）", new Date(), { test: true });
    expect(w.addon).toBe(WELCOME + 150_000);
    expect(w.paidEver).toBe(false);
    expect(tokens.isPaidUser(w)).toBe(false);
  });

  test("refreshPaidEver 按订单重算：唯一一笔被回收 → false；还有别的付款 → 仍是 true；部分退款（还剩没退的份）→ 仍是 true", async () => {
    const solo = await makeUser();
    await wallet.getWallet(solo.id);
    const o1 = await seedOrder(solo.id, { channel: "play" });
    await wallet.credit(solo.id, 200_000, "recharge", `Play 订单 ${o1.orderNo}`);
    expect((await wallet.getWallet(solo.id)).paidEver).toBe(true);
    await TokenOrder.updateOne({ _id: o1._id }, { $set: { revokedAt: new Date(), status: "refunded" } });
    expect(await wallet.refreshPaidEver(solo.id)).toBe(false);
    expect(tokens.isPaidUser(await wallet.getWallet(solo.id))).toBe(false);

    const two = await makeUser();
    await wallet.getWallet(two.id);
    await seedOrder(two.id, { channel: "play", status: "refunded", revokedAt: new Date() });
    await seedOrder(two.id, { kind: "plan", planId: "std", packTokens: 0 });
    expect(await wallet.refreshPaidEver(two.id)).toBe(true);

    const partial = await makeUser();
    await wallet.getWallet(partial.id);
    await seedOrder(partial.id, { channel: "play", status: "refunded", revokedAt: new Date(), quantity: 3, voidedQuantity: 1 });
    expect(await wallet.refreshPaidEver(partial.id)).toBe(true);
    await TokenOrder.updateMany({ user: partial.id }, { $set: { voidedQuantity: 3 } });
    expect(await wallet.refreshPaidEver(partial.id)).toBe(false);
  });

  test("回填与并发充值撞车：充值置的 true 不会被回填的 false 盖掉", async () => {
    const u = await makeUser();
    await User.updateOne({ _id: u.id }, { $set: { tokenWallet: { plan: 0, addon: 0, planId: "free", cycle: "2026-10", day: "2026-10-07", debt: 0, debtSince: null } } });
    await Promise.all([wallet.getWallet(u.id, dayAt("2026-10-07")), wallet.credit(u.id, 200_000, "recharge", "订单 Y", dayAt("2026-10-07"))]);
    expect((await wallet.getWallet(u.id, dayAt("2026-10-07"))).paidEver).toBe(true);
  });

  test("GET /api/me/wallet 回 paid 与 free（App 照这三个数说免费额度，不抄数）", async () => {
    const u = await makeUser();
    const r1 = await request(app).get("/api/me/wallet").set(u.auth).expect(200);
    expect(r1.body.paid).toBe(false);
    expect(r1.body.free).toEqual({ welcomeTokens: WELCOME, dailyTokens: DAILY, dailyCapTokens: CAP });
    expect(r1.body.wallet.paidEver).toBe(false);
    await wallet.credit(u.id, 200_000, "recharge", "订单 Z");
    const r2 = await request(app).get("/api/me/wallet").set(u.auth).expect(200);
    expect(r2.body.paid).toBe(true);
  });

  test("充过钱的免费版用户能出高清（门禁认 paidEver，不只认套餐）", async () => {
    const u = await makeUser();
    await wallet.getWallet(u.id);
    process.env.ARK_API_KEY = "test-key";
    const spy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ id: "cgt-fq-hd-1" }), { status: 200 }));
    try {
      const body = { model: "doubao-seedance-2-0-mini-260615", content: [{ type: "text", text: "x" }], duration: 4, resolution: "720p" };
      const denied = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).send(body);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("PLAN_REQUIRED");
      await wallet.credit(u.id, 1_000_000, "recharge", "订单 HD");
      const ok = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).send(body);
      expect(ok.status).toBe(200);
    } finally {
      spy.mockRestore();
      delete process.env.ARK_API_KEY;
    }
  });
});
