/**
 * Google Play 结算：服务端查验、发币、消耗、退款回收。
 * 用例出自方案 §15.7 的测试矩阵里与 Play 相关的那几条（其余在 tests/walletDebt.spec.js）。
 *
 * ★ 上游（androidpublisher + oauth2）全部用 fetch spy 换掉：测的是我们的判据与幂等，
 *   不是 Google 的接口。真实凭据在 .env 里，任何测试都不该碰到它。
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const crypto = require('crypto');

let mongod;
let app;
let User;
let TokenOrder;
let TokenLedger;
let wallet;
let play;
let signToken;
let fetchSpy;

// 自签一把测试用的 RSA 私钥：不碰任何真实凭据
const { privateKey: TEST_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.PLAY_PACKAGE_NAME = 'org.ideahubs.app';
  process.env.PLAY_SA_EMAIL = 'test-sa@example.iam.gserviceaccount.com';
  process.env.PLAY_SA_PRIVATE_KEY = TEST_KEY.replace(/\n/g, '\\n');
  process.env.PLAY_RTDN_SECRET = 'rtdn-secret';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  User = require('../src/models/User');
  TokenOrder = require('../src/models/TokenOrder');
  TokenLedger = require('../src/models/TokenLedger');
  wallet = require('../src/services/tokenWallet.service');
  play = require('../src/services/payment/play.service');
  ({ signToken } = require('../src/utils/jwt'));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await TokenOrder.syncIndexes();
  fetchSpy = jest.spyOn(global, 'fetch');
  upstream = { purchase: null, consumeOk: true, voided: [] };
  fetchSpy.mockImplementation(async (url) => route(String(url)));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

let upstream;

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

/** 假的 Google：oauth2 发 token，androidpublisher 按 upstream 里摆好的剧本回 */
function route(url) {
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json(200, { access_token: 'fake-token', expires_in: 3600 });
  if (url.includes('/purchases/productsv2/tokens/')) {
    if (!upstream.purchase) return json(404, { error: { message: 'not found' } });
    return json(200, upstream.purchase);
  }
  if (url.includes(':consume')) return upstream.consumeOk ? json(200, {}) : json(500, { error: { message: 'boom' } });
  if (url.includes('/purchases/voidedpurchases')) return json(200, { voidedPurchases: upstream.voided });
  throw new Error(`测试里不该打这个地址：${url}`);
}

/** productsv2 的真实形状：quantity / productId / consumptionState 都在 productLineItem[] 里 */
function purchaseBody({ productId = 'tokens_150k', quantity = 1, state = 'PURCHASED', accountId = '', isTest = false, orderId = 'GPA.1234' } = {}) {
  return {
    orderId,
    regionCode: 'US',
    purchaseStateContext: { purchaseState: state },
    productLineItem: [{ productId, productOfferDetails: { quantity, consumptionState: 'CONSUMPTION_STATE_UNSPECIFIED' } }],
    ...(accountId ? { obfuscatedExternalAccountId: accountId } : {}),
    ...(isTest ? { testPurchaseContext: { fopType: 'TEST' } } : {}),
  };
}

async function makeUser(role = 'user') {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const u = await User.create({ username: `pl_${rand}`, email: `${rand}@test.local`, role, passwordHash: 'x' });
  return { user: u, token: signToken(u), acct: play.obfuscatedAccountId(u._id) };
}

function redeem(token, purchaseToken) {
  return request(app).post('/api/pay/play/redeem').set('Authorization', `Bearer ${token}`).send({ purchaseToken });
}

async function balance(userId) {
  const u = await User.findById(userId).select('tokenWallet').lean();
  return u.tokenWallet.plan + u.tokenWallet.addon;
}

describe('兑换', () => {
  it('查验通过 → 发币、落单、consume，钱包加上', async () => {
    const { user, token, acct } = await makeUser();
    await wallet.ensureWallet(user._id);
    const before = await balance(user._id);
    upstream.purchase = purchaseBody({ accountId: acct });
    const res = await redeem(token, 'ptok-1');
    expect(res.status).toBe(200);
    expect(res.body.granted).toBe(150_000);
    expect(await balance(user._id)).toBe(before + 150_000);
    const order = await TokenOrder.findOne({ playPurchaseToken: 'ptok-1' }).lean();
    expect(order.status).toBe('settled');
    expect(order.grantedAt).toBeTruthy();
    expect(order.consumedAt).toBeTruthy(); // ★ consume 在发币之后（P2）
    expect(order.channel).toBe('play');
  });

  it('一次买多份：按 quantity 乘', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, quantity: 3 });
    await redeem(token, 'ptok-q3');
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-q3' }).lean()).grantedTokens).toBe(450_000);
  });

  it('★ 幂等：同一个 token 兑两次只发一次币', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-dup');
    const before = await balance(user._id);
    const again = await redeem(token, 'ptok-dup');
    expect(again.status).toBe(200);
    expect(again.body.code).toBe('duplicate');
    expect(await balance(user._id)).toBe(before);
    expect(await TokenOrder.countDocuments({ playPurchaseToken: 'ptok-dup' })).toBe(1);
  });

  it('★ 并发兑换只发一次（唯一索引兜底，不是先查后写）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await Promise.all([redeem(token, 'ptok-race'), redeem(token, 'ptok-race')]);
    expect(await TokenOrder.countDocuments({ playPurchaseToken: 'ptok-race' })).toBe(1);
    const rows = await TokenLedger.find({ user: user._id, reason: 'recharge' }).lean();
    expect(rows).toHaveLength(1);
  });

  it('★ purchaseState 不是 PURCHASED 一律不发币（PENDING 也不行）', async () => {
    const { user, token, acct } = await makeUser();
    for (const state of ['PENDING', 'CANCELLED', 'PURCHASE_STATE_UNSPECIFIED']) {
      upstream.purchase = purchaseBody({ accountId: acct, state });
      const res = await redeem(token, `ptok-${state}`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('NOT_PURCHASED');
    }
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'recharge' })).toBe(0);
  });

  it('★ 商品不在表里 → 不发币（Play Console 与 config/play.js 的 sku 必须逐字相同）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, productId: 'tokens_999k' });
    const res = await redeem(token, 'ptok-unknown');
    expect(res.body.code).toBe('UNKNOWN_PRODUCT');
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'recharge' })).toBe(0);
  });

  it('★ 别人的购买兑不到我账上（obfuscatedExternalAccountId 对不上）', async () => {
    const a = await makeUser();
    const b = await makeUser();
    upstream.purchase = purchaseBody({ accountId: b.acct });
    const res = await redeem(a.token, 'ptok-mismatch');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_MISMATCH');
  });

  it('没配 Play 时整条关掉（501），不是半开', async () => {
    const { token } = await makeUser();
    const saved = process.env.PLAY_SA_EMAIL;
    delete process.env.PLAY_SA_EMAIL;
    try {
      const res = await redeem(token, 'ptok-off');
      expect(res.status).toBe(501);
      expect(res.body.code).toBe('PLAY_NOT_CONFIGURED');
    } finally {
      process.env.PLAY_SA_EMAIL = saved;
    }
  });
});

describe('consume 失败之后（2026-09-25 评审逮到的 critical）', () => {
  it('★ consume 撞上游错误 → 重试 redeem 会**补跑** consume（老写法永远补不上）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    upstream.consumeOk = false; // 第一次 consume 失败
    await redeem(token, 'ptok-consume-fail');
    let order = await TokenOrder.findOne({ playPurchaseToken: 'ptok-consume-fail' }).lean();
    expect(order.consumedAt).toBeNull();
    expect(order.consumeAttempts).toBe(1); // 失败要留痕，否则事后看不出试过几次

    upstream.consumeOk = true; // 上游恢复
    const again = await redeem(token, 'ptok-consume-fail');
    expect(again.body.code).toBe('duplicate');
    order = await TokenOrder.findOne({ playPurchaseToken: 'ptok-consume-fail' }).lean();
    expect(order.consumedAt).not.toBeNull(); // ← 老写法这里仍是 null：3 天后被 Google 自动退款
    expect(order.grantedTokens).toBe(150_000); // 没有重复发币
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'recharge' })).toBe(1);
  });

  it('★ 清扫器把没 consume 的订单接着跑完（测试购买走 60 秒快车道）', async () => {
    const { token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, isTest: true });
    upstream.consumeOk = false;
    await redeem(token, 'ptok-sweep');
    // 退避窗口内不重试
    let r = await play.sweepUnconsumed({ now: new Date(Date.now() + 10_000) });
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-sweep' }).lean()).consumedAt).toBeNull();
    // 过了 60 秒就重试
    upstream.consumeOk = true;
    r = await play.sweepUnconsumed({ now: new Date(Date.now() + 61_000) });
    expect(r.handled).toBeGreaterThan(0);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-sweep' }).lean()).consumedAt).not.toBeNull();
  });

  it('★ 崩在「抢到发币权」与「币真的进账」之间 → 清扫器按账本判断并补发', async () => {
    const { user } = await makeUser();
    await wallet.ensureWallet(user._id);
    const before = (await wallet.getWallet(user._id)).plan;
    // 造出那个中间态：grantedAt 有值、status 还是 paid、账本里没有这笔
    await TokenOrder.create({
      orderNo: 'PLAYMID1',
      user: user._id,
      kind: 'recharge',
      amountFen: 0,
      channel: 'play',
      playPurchaseToken: 'ptok-mid',
      playProductId: 'tokens_150k',
      packTokens: 150_000,
      status: 'paid',
      settledAt: new Date(),
      grantedAt: new Date(),
      consumedAt: new Date(), // consume 那半已经做完，只测补发
    });
    const r = await play.sweepUnconsumed();
    expect(r.granted).toBe(150_000);
    const after = await User.findById(user._id).select('tokenWallet').lean();
    expect(after.tokenWallet.plan + after.tokenWallet.addon).toBe(before + 150_000);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-mid' }).lean()).status).toBe('settled');
    // 再跑一轮不许重复补发
    await play.sweepUnconsumed();
    const after2 = await User.findById(user._id).select('tokenWallet').lean();
    expect(after2.tokenWallet.plan + after2.tokenWallet.addon).toBe(before + 150_000);
  });

  it('★ 已经发过币的（账本里有那条 recharge）不许再补发一次', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-done');
    const bal = await balance(user._id);
    // 人为把 status 打回 paid，模拟「状态没写成功但币已经发了」
    await TokenOrder.updateOne({ playPurchaseToken: 'ptok-done' }, { $set: { status: 'paid' } });
    const r = await play.sweepUnconsumed();
    expect(r.granted).toBe(0);
    expect(await balance(user._id)).toBe(bal);
  });
});

describe('测试购买（许可测试员）', () => {
  it('照常发币，但订单与流水都标 isTest', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, isTest: true });
    const res = await redeem(token, 'ptok-test');
    expect(res.body.granted).toBe(150_000);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-test' }).lean()).isTest).toBe(true);
  });

  it('★ 测试购买被退款 → 回收照做，但**不产生欠额**（否则测试员会把自己冻住）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, isTest: true });
    await redeem(token, 'ptok-test-refund');
    // 先把余额花掉一部分，让回收收不回全额
    await wallet.debit(user._id, 400_000, '测试消耗');
    const r = await play.revokeByToken({ purchaseToken: 'ptok-test-refund' });
    expect(r.code).toBe('revoked');
    expect(r.shortfall).toBeGreaterThan(0);
    const w = await User.findById(user._id).select('tokenWallet').lean();
    expect(w.tokenWallet.debt).toBe(0); // 豁免
  });

  it('单账号有日/月上限（否则测试购买就是无限 token）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, productId: 'tokens_4500k', isTest: true });
    const first = await redeem(token, 'ptok-big-1');
    expect(first.status).toBe(429); // 4.5M > 日上限 500k
    expect(first.body.code).toBe('TEST_LIMIT');
  });
});

describe('退款回收', () => {
  it('全额退款 → 收回已发的 token，订单终态 refunded', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-refund');
    const before = await balance(user._id);
    const r = await play.revokeByToken({ purchaseToken: 'ptok-refund' });
    expect(r.code).toBe('revoked');
    expect(await balance(user._id)).toBe(before - 150_000);
    const order = await TokenOrder.findOne({ playPurchaseToken: 'ptok-refund' }).lean();
    expect(order.status).toBe('refunded');
    expect(order.clawbackTokens).toBe(150_000);
  });

  it('★ 部分退款按比例，分母取订单快照里的 quantity', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, quantity: 3 });
    await redeem(token, 'ptok-partial');
    const before = await balance(user._id);
    await play.revokeByToken({ purchaseToken: 'ptok-partial', voidedQuantity: 1 });
    expect(await balance(user._id)).toBe(before - 150_000); // 450k 的 1/3
  });

  it('★ RTDN 与每小时轮询同时命中 → 只回收一次', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-twice');
    const before = await balance(user._id);
    const [a, b] = await Promise.all([
      play.revokeByToken({ purchaseToken: 'ptok-twice' }),
      play.revokeByToken({ purchaseToken: 'ptok-twice' }),
    ]);
    expect([a.code, b.code].sort()).toEqual(['duplicate', 'revoked']);
    expect(await balance(user._id)).toBe(before - 150_000);
  });

  it('★★ 退款通知**先于**兑换到达 → 那笔购买永远不再发币', async () => {
    const { user, token, acct } = await makeUser();
    const r0 = await play.revokeByToken({ purchaseToken: 'ptok-early' });
    expect(r0.code).toBe('voided_before_redeem');
    upstream.purchase = purchaseBody({ accountId: acct });
    const res = await redeem(token, 'ptok-early');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVOKED');
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'recharge' })).toBe(0);
  });

  it('★★ 退款恰好落在「订单已落、币还没发」那一拍 → 仍然不发币（抢占条件带 revokedAt）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    // 模拟真正的竞态：订单刚落库、发币抢占还没执行，退款通知就到了。
    // 早先那道 `existing.revokedAt` 检查在这一拍根本还没有东西可查 ——
    // 真正兜住的是抢占条件里的 `revokedAt: null`。
    const realCreate = TokenOrder.create.bind(TokenOrder);
    const spy = jest.spyOn(TokenOrder, 'create').mockImplementation(async (doc) => {
      const created = await realCreate(doc);
      await TokenOrder.updateOne({ _id: created._id }, { $set: { revokedAt: new Date() } });
      return created;
    });
    try {
      const res = await redeem(token, 'ptok-race-void');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REVOKED');
      expect(await TokenLedger.countDocuments({ user: user._id, reason: 'recharge' })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('★ 抢到结算权但还没发币（崩在中间）→ 回收**推迟**，不把欠额算成 0', async () => {
    const { user } = await makeUser();
    await TokenOrder.create({
      orderNo: 'PLAYCRASH1',
      user: user._id,
      kind: 'recharge',
      amountFen: 0,
      channel: 'play',
      playPurchaseToken: 'ptok-crash',
      packTokens: 150_000,
      status: 'paid',
      settledAt: new Date(),
      grantedAt: null,
    });
    const r = await play.revokeByToken({ purchaseToken: 'ptok-crash' });
    expect(r.code).toBe('deferred');
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-crash' }).lean()).revokedAt).toBeNull();
  });

  it('轮询把清单里的每一条都回收掉', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-poll');
    upstream.voided = [{ purchaseToken: 'ptok-poll', voidedQuantity: 0, voidedSource: 1, voidedReason: 2 }];
    const r = await play.pollVoided({ sinceMs: Date.now() - 3600_000 });
    expect(r.handled).toBe(1);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-poll' }).lean()).status).toBe('refunded');
  });
});

describe('归属与部分退款（2026-09-25 评审补）', () => {
  it('★ 重复兑换的快路径也要校验归属：别人的 token 问不出「发了多少」', async () => {
    const a = await makeUser();
    const b = await makeUser();
    upstream.purchase = purchaseBody({ accountId: a.acct });
    await redeem(a.token, 'ptok-owned');
    const res = await redeem(b.token, 'ptok-owned');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_MISMATCH');
    expect(res.body.granted).toBeUndefined();
  });

  it('★ 已退款的购买再兑 → REVOKED，而不是「已到账」', async () => {
    const { token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-revoked-then-redeem');
    await play.revokeByToken({ purchaseToken: 'ptok-revoked-then-redeem' });
    const res = await redeem(token, 'ptok-revoked-then-redeem');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVOKED');
  });

  it('★ RTDN 的部分退款不按全额收，交给带份数的轮询', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct, quantity: 3 });
    await redeem(token, 'ptok-rtdn-partial');
    const before = await balance(user._id);
    const res = await request(app)
      .post('/api/pay/play/rtdn?key=rtdn-secret')
      .send({ message: { data: Buffer.from(JSON.stringify({ voidedPurchaseNotification: { purchaseToken: 'ptok-rtdn-partial', refundType: 2 } })).toString('base64') } });
    expect(res.status).toBe(200);
    // 没有按全额收，也没有抢掉 revokedAt（否则轮询永远纠正不回来）
    expect(await balance(user._id)).toBe(before);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-rtdn-partial' }).lean()).revokedAt).toBeNull();
    // 轮询带着份数来，按 1/3 收
    upstream.voided = [{ purchaseToken: 'ptok-rtdn-partial', voidedQuantity: 1 }];
    await play.pollVoided({ sinceMs: Date.now() - 3600_000 });
    expect(await balance(user._id)).toBe(before - 150_000);
  });

  it('★ 拉作废清单必须带 includeQuantityBasedPartialRefund（默认 false = 看不见部分退款）', async () => {
    await play.pollVoided({ sinceMs: 1 });
    const call = fetchSpy.mock.calls.map((c) => String(c[0])).find((u) => u.includes('voidedpurchases'));
    expect(call).toContain('includeQuantityBasedPartialRefund=true');
  });

  it('混淆账号 id 拿得到（拿不到的话账号绑定那道闸永远是空的）', async () => {
    const { user, token } = await makeUser();
    const res = await request(app).get('/api/pay/play/account').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.obfuscatedAccountId).toBe(play.obfuscatedAccountId(user._id));
  });
});

describe('RTDN 端点', () => {
  function rtdn(key, payload) {
    return request(app)
      .post(`/api/pay/play/rtdn${key === null ? '' : `?key=${key}`}`)
      .send({ message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') } });
  }

  it('密钥不对 → 404（不告诉外面这里有个端点）', async () => {
    const res = await rtdn('wrong', {});
    expect(res.status).toBe(404);
  });

  it('退款通知 → 回收，并且**一定回 200**（回非 2xx 会让 Pub/Sub 无限重推）', async () => {
    const { user, token, acct } = await makeUser();
    upstream.purchase = purchaseBody({ accountId: acct });
    await redeem(token, 'ptok-rtdn');
    const res = await rtdn('rtdn-secret', { voidedPurchaseNotification: { purchaseToken: 'ptok-rtdn', refundType: 1 } });
    expect(res.status).toBe(200);
    expect((await TokenOrder.findOne({ playPurchaseToken: 'ptok-rtdn' }).lean()).status).toBe('refunded');
  });

  it('消息体是坏的也回 200（否则同一条坏消息会被无限重推）', async () => {
    const res = await request(app).post('/api/pay/play/rtdn?key=rtdn-secret').send({ message: { data: 'not-base64-json' } });
    expect(res.status).toBe(200);
  });
});

describe('配置出口', () => {
  it('/api/pay/config 告诉客户端 Play 开没开、卖哪些 sku', async () => {
    const res = await request(app).get('/api/pay/config');
    expect(res.body.play.enabled).toBe(true);
    expect(res.body.play.products.map((p) => p.sku)).toContain('tokens_150k');
  });
});
