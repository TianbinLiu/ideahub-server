// tests/playBilling.spec.js
// 覆盖：Google Play 结算服务端阶段 1（D15，统一执行顺序第 2 批）—— 会话、兑换、consume 重试、退款回收、删号、自检。
//
// ★ 盯的是 services/payment/playBilling.service.js 文件头 P1~P8。全部是「做错了不报错、只会白送或多扣 token」那类，
//   只有用例看得见。Google 那一侧用假传输（setPlayApiForTests），fixture 按官方参考页的 ProductPurchaseV2 /
//   voidedpurchases 形状写 —— 不需要真的在 Play 上买东西，也一次都不出网。
// ★ 这些环境变量必须在 require("../src/app") **之前**设：PAY_ALLOW_MOCK 是 channels.js 在模块加载时读的
//   （用来验「Play 的单不许走回调结算」）；GPB 的开关与盐是请求时现读的，改了立刻生效。
process.env.PLAY_BILLING_ENABLED = "1";
process.env.PLAY_ACCOUNT_SALT = "test-salt-0123456789abcdef-0123456789abcdef";
process.env.PAY_ALLOW_MOCK = "1";

const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let TokenOrder;
let TokenLedger;
let User;
let play;
let PlayApiError;
let setPlayApiForTests;

const FREE = 300_000;

/** Google 那一侧的假传输。purchases: token → ProductPurchaseV2（或一个要抛的 Error） */
const fake = {
  purchases: new Map(),
  consumeCalls: [],
  failConsume: 0,
  voided: [],
  reset() {
    this.purchases.clear();
    this.consumeCalls = [];
    this.failConsume = 0;
    this.voided = [];
  },
  async getProductPurchaseV2(token) {
    const p = fake.purchases.get(token);
    if (p instanceof Error) throw p;
    if (!p) throw new PlayApiError("Google Play API 404", { status: 404, notFound: true });
    return JSON.parse(JSON.stringify(p));
  },
  async consume(productId, token) {
    fake.consumeCalls.push({ productId, token });
    if (fake.failConsume > 0) {
      fake.failConsume -= 1;
      throw new PlayApiError("Google Play API 503：backend error", { status: 503 });
    }
    return {};
  },
  async listVoided() {
    return { voidedPurchases: fake.voided };
  },
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  TokenOrder = require("../src/models/TokenOrder");
  TokenLedger = require("../src/models/TokenLedger");
  User = require("../src/models/User");
  play = require("../src/services/payment/playBilling.service");
  ({ PlayApiError, setPlayApiForTests } = require("../src/services/payment/playApi"));
  setPlayApiForTests(fake);
  // 并发用例靠 purchaseTokenHash 的唯一索引兜底：索引建好之前跑会假绿
  await TokenOrder.init();
  // ★ 60 秒：jest 默认的钩子上限是 5 秒，本机冷启动内存 Mongo + 加载整个 app 偶尔会超（与代码无关的假红）
}, 60_000);

afterAll(async () => {
  setPlayApiForTests(null);
  delete process.env.PLAY_BILLING_ENABLED;
  delete process.env.PLAY_ACCOUNT_SALT;
  delete process.env.PAY_ALLOW_MOCK;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => fake.reset());

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `gpb${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

/** 客户端下单时交给 Google 的那个值（测试里照定义独立算一遍，不借服务端的函数） */
const acct = (userId) => crypto.createHmac("sha256", process.env.PLAY_ACCOUNT_SALT).update(String(userId)).digest("hex");
const hashOf = (token) => crypto.createHash("sha256").update(token).digest("hex");

function newToken() {
  seq += 1;
  return `purchase-token-${seq}-${crypto.randomBytes(12).toString("hex")}`;
}

/** 一份 ProductPurchaseV2（形状按官方参考页） */
function purchaseOf({ productId = "tokens_1m", state = "PURCHASED", accountId, quantity = 1, consumed = false, test = false, orderId, extraLine = false } = {}) {
  const line = (id) => ({
    productId: id,
    productOfferDetails: {
      offerToken: "offer-token",
      quantity,
      refundableQuantity: quantity,
      consumptionState: consumed ? "CONSUMPTION_STATE_CONSUMED" : "CONSUMPTION_STATE_YET_TO_BE_CONSUMED",
    },
  });
  return {
    kind: "androidpublisher#productPurchaseV2",
    productLineItem: extraLine ? [line(productId), line("tokens_200k")] : [line(productId)],
    purchaseStateContext: { purchaseState: state },
    ...(test ? { testPurchaseContext: { fopType: "TEST" } } : {}),
    ...(state === "PENDING" ? {} : { orderId: orderId || `GPA.${seq}-${crypto.randomBytes(4).toString("hex")}` }),
    ...(accountId !== undefined ? { obfuscatedExternalAccountId: accountId } : {}),
    regionCode: "US",
    purchaseCompletionTime: new Date().toISOString(),
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  };
}

async function balanceOf(token) {
  const r = await request(app).get("/api/me/wallet").set("Authorization", `Bearer ${token}`).expect(200);
  return Number(r.body.wallet.plan || 0) + Number(r.body.wallet.addon || 0);
}

function redeem(token, body) {
  return request(app).post("/api/pay/play/redeem").set("Authorization", `Bearer ${token}`).send(body);
}

describe("开关与会话", () => {
  test("PLAY_BILLING_ENABLED 没开：整组 404，像不存在一样", async () => {
    const u = await registerUser();
    process.env.PLAY_BILLING_ENABLED = "0";
    try {
      await request(app).get("/api/pay/play/session").set("Authorization", `Bearer ${u.token}`).expect(404);
      await redeem(u.token, { purchaseToken: "x", productId: "tokens_1m" }).expect(404);
    } finally {
      process.env.PLAY_BILLING_ENABLED = "1";
    }
    await request(app).get("/api/pay/play/session").set("Authorization", `Bearer ${u.token}`).expect(200);
  });

  test("session：obfuscatedAccountId = HMAC-SHA256(user._id, 盐)，64 位 hex、因人而异；商品表来自 playProducts", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const ra = await request(app).get("/api/pay/play/session").set("Authorization", `Bearer ${a.token}`).expect(200);
    const rb = await request(app).get("/api/pay/play/session").set("Authorization", `Bearer ${b.token}`).expect(200);
    expect(ra.body.enabled).toBe(true);
    expect(ra.body.obfuscatedAccountId).toMatch(/^[0-9a-f]{64}$/);
    expect(ra.body.obfuscatedAccountId).toBe(acct(a.userId));
    expect(rb.body.obfuscatedAccountId).not.toBe(ra.body.obfuscatedAccountId);
    expect(ra.body.obfuscatedAccountId).not.toContain(a.userId);
    expect(ra.body.products).toEqual(
      expect.arrayContaining([
        { productId: "tokens_200k", kind: "consumable", tokens: 200_000 },
        { productId: "tokens_1m", kind: "consumable", tokens: 1_000_000 },
        { productId: "tokens_5m", kind: "consumable", tokens: 5_000_000 },
      ]),
    );
  });

  test("没登录：401", async () => {
    await request(app).get("/api/pay/play/session").expect(401);
    await request(app).post("/api/pay/play/redeem").send({ purchaseToken: "x", productId: "tokens_1m" }).expect(401);
  });
});

describe("兑换", () => {
  test("PURCHASED：发币进 addon、流水 iap_recharge、最后 consume 一次、明文 token 删掉", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId), orderId: "GPA.1111-0001" }));

    const r = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(200);
    expect(r.body.code).toBe("settled");
    expect(r.body.order.productId).toBe("tokens_1m");
    expect(r.body.order.grantedTokens).toBe(1_000_000);
    expect(r.body.wallet.addon).toBe(1_000_000);
    expect(JSON.stringify(r.body)).not.toContain(t);

    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);
    expect(fake.consumeCalls).toEqual([{ productId: "tokens_1m", token: t }]);
    const o = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) }).select("+purchaseToken");
    expect(o.status).toBe("settled");
    expect(o.channel).toBe("google_play");
    expect(o.channelTxnId).toBe("GPA.1111-0001");
    expect(o.amountCheck).toBe("product");
    expect(o.amountFen).toBe(0);
    expect(o.consumeState).toBe("done");
    expect(o.purchaseToken).toBeUndefined();
    expect(JSON.stringify(o.raw)).not.toContain(t);
    const led = await TokenLedger.find({ user: u.userId, reason: { $in: ["iap_recharge", "iap_test", "recharge"] } }).lean();
    expect(led.map((x) => [x.reason, x.delta])).toEqual([["iap_recharge", 1_000_000]]);
  });

  test("PENDING：202、不发币、不 consume；付清之后同一个 token 再兑 → 原地那张单结算", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ state: "PENDING", accountId: acct(u.userId) }));

    const r1 = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(202);
    expect(r1.body.code).toBe("pending");
    expect(await balanceOf(u.token)).toBe(FREE);
    expect(fake.consumeCalls).toHaveLength(0);
    const pending = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) });
    expect(pending.settledAt).toBeNull();
    expect(pending.status).toBe("created");

    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId), orderId: "GPA.2222-0001" }));
    const r2 = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(200);
    expect(r2.body.code).toBe("settled");
    expect(await TokenOrder.countDocuments({ purchaseTokenHash: hashOf(t) })).toBe(1);
    expect(String((await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) }))._id)).toBe(String(pending._id));
    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);
  });

  test("CANCELLED / PURCHASE_STATE_UNSPECIFIED / 没见过的状态：一律 not_purchased，不建单不发币（判肯定）", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    for (const state of ["CANCELLED", "PURCHASE_STATE_UNSPECIFIED", "SOME_STATE_GOOGLE_ADDS_LATER"]) {
      const t = newToken();
      fake.purchases.set(t, purchaseOf({ state, accountId: acct(u.userId) }));
      const r = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(409);
      expect(r.body.code).toBe("not_purchased");
      expect(await TokenOrder.countDocuments({ purchaseTokenHash: hashOf(t) })).toBe(0);
    }
    expect(await balanceOf(u.token)).toBe(FREE);
    expect(fake.consumeCalls).toHaveLength(0);
  });

  test("Google 侧已经消费、本库没有发过币：already_consumed", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId), consumed: true }));
    const r = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(409);
    expect(r.body.code).toBe("already_consumed");
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("测试购买：默认不发；开 PLAY_ALLOW_TEST_PURCHASES 或管理员才发，流水记 iap_test", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ productId: "tokens_200k", accountId: acct(u.userId), test: true }));

    const blocked = await redeem(u.token, { purchaseToken: t, productId: "tokens_200k" }).expect(403);
    expect(blocked.body.code).toBe("test_purchase_blocked");
    expect(await balanceOf(u.token)).toBe(FREE);
    expect(await TokenOrder.countDocuments({ purchaseTokenHash: hashOf(t) })).toBe(0);

    process.env.PLAY_ALLOW_TEST_PURCHASES = "1";
    try {
      expect((await redeem(u.token, { purchaseToken: t, productId: "tokens_200k" }).expect(200)).body.code).toBe("settled");
    } finally {
      delete process.env.PLAY_ALLOW_TEST_PURCHASES;
    }
    expect(await balanceOf(u.token)).toBe(FREE + 200_000);
    const led = await TokenLedger.find({ user: u.userId, reason: { $in: ["iap_recharge", "iap_test"] } }).lean();
    expect(led.map((x) => x.reason)).toEqual(["iap_test"]);

    const admin = await registerUser();
    await User.updateOne({ _id: admin.userId }, { $set: { role: "admin" } });
    const t2 = newToken();
    fake.purchases.set(t2, purchaseOf({ productId: "tokens_200k", accountId: acct(admin.userId), test: true }));
    expect((await redeem(admin.token, { purchaseToken: t2, productId: "tokens_200k" }).expect(200)).body.code).toBe("settled");
  });

  test("账号对不上：account_mismatch，不建单、不发币、不 consume（Google 三天后自动退款）", async () => {
    const a = await registerUser();
    const b = await registerUser();
    await balanceOf(a.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(b.userId) }));
    const r = await redeem(a.token, { purchaseToken: t, productId: "tokens_1m" }).expect(403);
    expect(r.body.code).toBe("account_mismatch");
    expect(await balanceOf(a.token)).toBe(FREE);
    expect(fake.consumeCalls).toHaveLength(0);
    expect(await TokenOrder.countDocuments({ purchaseTokenHash: hashOf(t) })).toBe(0);
  });

  test("购买记录里没有账号（促销码）：account_unbound，记一条待处理，不发币、不 consume", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({}));
    const r = await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(403);
    expect(r.body.code).toBe("account_unbound");
    const o = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) });
    expect(o).toBeTruthy();
    expect(o.settledAt).toBeNull();
    expect(o.note).toMatch(/account_unbound/);
    expect(await balanceOf(u.token)).toBe(FREE);
    expect(fake.consumeCalls).toHaveLength(0);
  });

  test("token 在本包名下不存在（假 token / 别的 App 的 token）：not_purchased；Google 挂了：store_unavailable，不当成没买", async () => {
    const u = await registerUser();
    expect((await redeem(u.token, { purchaseToken: "token-of-another-app", productId: "tokens_1m" }).expect(409)).body.code).toBe(
      "not_purchased",
    );
    const t = newToken();
    fake.purchases.set(t, new PlayApiError("Google Play API 503", { status: 503 }));
    expect((await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(502)).body.code).toBe("store_unavailable");
    expect(await TokenOrder.countDocuments({ user: u.userId })).toBe(0);
  });

  test("商品：不在册 / 原型链上的键 / 与购买记录对不上 → unknown_product；缺参数 → bad_request", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ productId: "tokens_200k", accountId: acct(u.userId) }));
    for (const productId of ["tokens_999", "__proto__", "constructor"]) {
      expect((await redeem(u.token, { purchaseToken: t, productId }).expect(400)).body.code).toBe("unknown_product");
    }
    // 买的是 200k，报 5m（多报商品想多拿币）
    expect((await redeem(u.token, { purchaseToken: t, productId: "tokens_5m" }).expect(400)).body.code).toBe("unknown_product");
    expect((await redeem(u.token, { productId: "tokens_1m" }).expect(400)).body.code).toBe("bad_request");
    expect((await redeem(u.token, { purchaseToken: t }).expect(400)).body.code).toBe("bad_request");
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("数量不是 1 / 一笔里不止一个商品：quantity_unsupported", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId), quantity: 2 }));
    expect((await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(400)).body.code).toBe("quantity_unsupported");
    const t2 = newToken();
    fake.purchases.set(t2, purchaseOf({ accountId: acct(u.userId), extraLine: true }));
    expect((await redeem(u.token, { purchaseToken: t2, productId: "tokens_1m" }).expect(400)).body.code).toBe("quantity_unsupported");
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("同一个 token 并发兑换 6 次：只发一次币、只有一张单、只 consume 一次", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId) }));
    const rs = await Promise.all(Array.from({ length: 6 }, () => redeem(u.token, { purchaseToken: t, productId: "tokens_1m" })));
    const codes = rs.map((r) => r.body.code);
    expect(codes.filter((c) => c === "settled")).toHaveLength(1);
    expect(codes.filter((c) => c === "duplicate")).toHaveLength(5);
    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);
    expect(await TokenOrder.countDocuments({ purchaseTokenHash: hashOf(t) })).toBe(1);
    expect(fake.consumeCalls).toHaveLength(1);
  });

  test("兑过的 token：同一个人再交 → duplicate（不再发币）；换个人交 → account_mismatch", async () => {
    const a = await registerUser();
    const b = await registerUser();
    await balanceOf(a.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ accountId: acct(a.userId) }));
    await redeem(a.token, { purchaseToken: t, productId: "tokens_1m" }).expect(200);
    expect((await redeem(a.token, { purchaseToken: t, productId: "tokens_1m" }).expect(200)).body.code).toBe("duplicate");
    expect((await redeem(b.token, { purchaseToken: t, productId: "tokens_1m" }).expect(403)).body.code).toBe("account_mismatch");
    expect(await balanceOf(a.token)).toBe(FREE + 1_000_000);
  });

  test("consume 失败：币照样到账；重试字段写上，没到时间清扫器不碰，到了时间补上且不再发币", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.failConsume = 1;
    fake.purchases.set(t, purchaseOf({ accountId: acct(u.userId) }));
    expect((await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(200)).body.code).toBe("settled");
    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);

    let o = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) }).select("+purchaseToken");
    expect(o.consumeState).toBe("pending");
    expect(o.consumeTries).toBe(1);
    expect(o.consumeLastError).toMatch(/503/);
    expect(o.purchaseToken).toBe(t);
    expect(o.consumeNextAt.getTime()).toBeGreaterThan(Date.now());

    expect((await play.sweepPlayConsumes(new Date())).tried).toBe(0);
    const s = await play.sweepPlayConsumes(new Date(o.consumeNextAt.getTime() + 1000));
    expect(s).toEqual({ tried: 1, done: 1 });

    o = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) }).select("+purchaseToken");
    expect(o.consumeState).toBe("done");
    expect(o.purchaseToken).toBeUndefined();
    expect(fake.consumeCalls).toHaveLength(2);
    expect(await balanceOf(u.token)).toBe(FREE + 1_000_000);
  });

  test("Play 的单不许走 /api/pay/callback 结算（amountFen 是 0，「实付 < 应付」对它恒过）", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ state: "PENDING", accountId: acct(u.userId), productId: "tokens_5m" }));
    await redeem(u.token, { purchaseToken: t, productId: "tokens_5m" }).expect(202);
    const o = await TokenOrder.findOne({ purchaseTokenHash: hashOf(t) });
    await request(app).post("/api/pay/callback/mock").send({ orderNo: o.orderNo, channelTxnId: "forged", paidFen: 999_999 }).expect(400);
    await request(app).post("/api/pay/callback/mock").send({ orderNo: o.orderNo, failed: true }).expect(400);
    const after = await TokenOrder.findById(o._id);
    expect(after.settledAt).toBeNull();
    expect(after.status).toBe("created");
    expect(await balanceOf(u.token)).toBe(FREE);
  });
});

describe("退款 / 撤销回收（voided）", () => {
  async function settle(u, productId, orderId) {
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ productId, accountId: acct(u.userId), orderId }));
    await redeem(u.token, { purchaseToken: t, productId }).expect(200);
    return t;
  }

  test("每笔只回收一次：先扣 addon，流水 iap_clawback，再扫一轮不重复扣", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = await settle(u, "tokens_1m", "GPA.9001-0001");
    fake.voided = [
      { kind: "androidpublisher#voidedPurchase", purchaseToken: t, orderId: "GPA.9001-0001", voidedTimeMillis: String(Date.now()), voidedReason: 1, voidedSource: 0 },
    ];
    const s1 = await play.sweepVoidedPurchases(new Date(), { force: true });
    expect(s1.ran).toBe(true);
    expect(s1.clawed).toBe(1);
    const w = (await request(app).get("/api/me/wallet").set("Authorization", `Bearer ${u.token}`).expect(200)).body.wallet;
    expect(w.addon).toBe(0);
    expect(w.plan).toBe(FREE); // 当月额度原样还在：退款不该把会作废的额度换成永不过期的

    const s2 = await play.sweepVoidedPurchases(new Date(), { force: true });
    expect(s2.clawed).toBe(0);
    expect(s2.already).toBe(1);
    expect(await balanceOf(u.token)).toBe(FREE);
    const o = await TokenOrder.findOne({ channelTxnId: "GPA.9001-0001" });
    expect(o.clawbackState).toBe("done");
    expect(o.voidedAt).toBeTruthy();
    const led = await TokenLedger.find({ user: u.userId, reason: "iap_clawback" }).lean();
    expect(led.map((x) => x.delta)).toEqual([-1_000_000]);
  });

  test("余额扣不够：扣到 0 为止、不许负数，差额记在订单上（short）", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = await settle(u, "tokens_1m", "GPA.9003-0001");
    const wallet = require("../src/services/tokenWallet.service");
    expect(await wallet.debit(u.userId, 1_200_000, "测试里花掉一大半")).toBeTruthy(); // FREE + 1M 只剩 100k
    fake.voided = [{ purchaseToken: t, orderId: "GPA.9003-0001" }];
    const s = await play.sweepVoidedPurchases(new Date(), { force: true });
    expect(s.short).toBe(1);
    expect(await balanceOf(u.token)).toBe(0);
    const o = await TokenOrder.findOne({ channelTxnId: "GPA.9003-0001" });
    expect(o.clawbackState).toBe("short");
    expect(o.clawbackShortTokens).toBe(900_000);
  });

  test("用户已经不在了：记 user_gone，不抛；再扫也不重复", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = await settle(u, "tokens_200k", "GPA.9002-0001");
    await User.deleteOne({ _id: u.userId });
    fake.voided = [{ purchaseToken: t, orderId: "GPA.9002-0001" }];
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await play.sweepVoidedPurchases(new Date(), { force: true })).userGone).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("[play][admin]"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const o = await TokenOrder.findOne({ channelTxnId: "GPA.9002-0001" });
    expect(o.clawbackState).toBe("user_gone");
    expect(o.clawbackShortTokens).toBe(200_000);
    expect((await play.sweepVoidedPurchases(new Date(), { force: true })).already).toBe(1);
  });

  test("没发过币的单（待付）被撤销：记下来就好，没有可收的", async () => {
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ state: "PENDING", accountId: acct(u.userId) }));
    await redeem(u.token, { purchaseToken: t, productId: "tokens_1m" }).expect(202);
    fake.voided = [{ purchaseToken: t }];
    expect((await play.sweepVoidedPurchases(new Date(), { force: true })).unsettled).toBe(1);
    expect(await balanceOf(u.token)).toBe(FREE);
  });

  test("不 force 时一天最多真跑一次（lastRunAt 落库，双实例共用）", async () => {
    const t0 = new Date(Date.now() + 40 * 24 * 3600_000); // 挪到所有用例之后，避开前面 force 写下的 lastRunAt
    expect((await play.sweepVoidedPurchases(t0)).ran).toBe(true);
    expect((await play.sweepVoidedPurchases(new Date(t0.getTime() + 3600_000))).ran).toBe(false);
    expect((await play.sweepVoidedPurchases(new Date(t0.getTime() + 25 * 3600_000))).ran).toBe(true);
  });
});

describe("删号", () => {
  test("管理员硬删：Play 订单行去标识化后留下（还认得出 voided），别的订单照删", async () => {
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const u = await registerUser();
    await balanceOf(u.token);
    const t = newToken();
    fake.purchases.set(t, purchaseOf({ productId: "tokens_200k", accountId: acct(u.userId), orderId: "GPA.9100-0001" }));
    await redeem(u.token, { purchaseToken: t, productId: "tokens_200k" }).expect(200);
    await request(app)
      .post("/api/pay/orders")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ kind: "recharge", tokens: 200_000 })
      .expect(201);

    const removed = await purgeUserCascade(u.userId);
    expect(removed.tokenOrdersDeidentified).toBe(1);
    expect(removed.tokenOrders).toBe(1);

    const o = await TokenOrder.findOne({ channelTxnId: "GPA.9100-0001" }).select("+purchaseToken").lean();
    expect(o).toBeTruthy();
    expect(o.user).toBeUndefined();
    expect(o.raw).toBeUndefined();
    expect(o.purchaseToken).toBeUndefined();
    expect(o.purchaseTokenHash).toBe(hashOf(t));
    expect(o.grantedTokens).toBe(200_000);
    expect(o.status).toBe("settled");

    fake.voided = [{ purchaseToken: t, orderId: "GPA.9100-0001" }];
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await play.sweepVoidedPurchases(new Date(), { force: true })).userGone).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("配置自检（不出网）", () => {
  const sa = Buffer.from(
    JSON.stringify({ client_email: "gpb@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" }),
  ).toString("base64");
  const salt = "s".repeat(40);

  test("只查配了一半 / 解不出 / 盐太短 / 包名不对；什么都没配是合法的（开关默认关）", () => {
    const { collectPlayBillingProblems } = require("../src/config/playBilling");
    expect(collectPlayBillingProblems({})).toEqual([]);
    expect(collectPlayBillingProblems({ PLAY_BILLING_ENABLED: "1", PLAY_SA_JSON_B64: sa, PLAY_ACCOUNT_SALT: salt })).toEqual([]);
    expect(collectPlayBillingProblems({ PLAY_BILLING_ENABLED: "1" })).toHaveLength(1);
    expect(collectPlayBillingProblems({ PLAY_SA_JSON_B64: sa })).toHaveLength(1);
    expect(collectPlayBillingProblems({ PLAY_ACCOUNT_SALT: salt })).toHaveLength(1);
    expect(collectPlayBillingProblems({ PLAY_SA_JSON_B64: Buffer.from("not json").toString("base64"), PLAY_ACCOUNT_SALT: salt })).toHaveLength(1);
    expect(collectPlayBillingProblems({ PLAY_SA_JSON_B64: sa, PLAY_ACCOUNT_SALT: "short" })).toHaveLength(1);
    expect(collectPlayBillingProblems({ PLAY_PACKAGE_NAME: "com.other.app" })).toHaveLength(1);
  });

  test("并进了 preflight 的总检查", () => {
    const { collectConfigProblems } = require("../src/config/preflight");
    const { problems } = collectConfigProblems({ PLAY_BILLING_ENABLED: "1", JWT_SECRET: "x".repeat(40) });
    expect(problems.some((p) => p.includes("PLAY_BILLING_ENABLED"))).toBe(true);
  });

  test("setPlayApiForTests 在非 test 环境直接抛（生产路径换不掉真 API）", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => setPlayApiForTests(fake)).toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
