/**
 * 退款欠额与冻结（方案 §15.4，用例出自 §15.7 的测试矩阵）。
 *
 * ★ 这里测的是**内核**：回收、差额转欠额、抵债、免除、冻结。
 *   与 Play 渠道相关的那几条（RTDN 与轮询抢占、退款先于 redeem、崩在结算与发币之间）
 *   属于 Play 结算那一步，落在它自己的套件里。
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongod;
let app;
let User;
let TokenLedger;
let wallet;
let signToken;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.ARK_API_KEY = process.env.ARK_API_KEY || 'test-ark-key';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
  User = require('../src/models/User');
  TokenLedger = require('../src/models/TokenLedger');
  wallet = require('../src/services/tokenWallet.service');
  ({ signToken } = require('../src/utils/jwt'));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
});

async function makeUser(role = 'user') {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const u = await User.create({ username: `wd_${rand}`, email: `${rand}@test.local`, role, passwordHash: 'x' });
  return { user: u, token: signToken(u) };
}

/** 直接把余额摆成指定的两桶值（绕过发币路径，专心测回收） */
async function setBalance(userId, plan, addon) {
  await wallet.ensureWallet(userId);
  await User.updateOne({ _id: userId }, { $set: { 'tokenWallet.plan': plan, 'tokenWallet.addon': addon } });
}

async function walletOf(userId) {
  const u = await User.findById(userId).select('tokenWallet').lean();
  return u.tokenWallet;
}

describe('回收（§15.4 R-1/R-2）', () => {
  it('余额充足：扣掉就完了，不欠不冻', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 20000, 50000);
    const r = await wallet.revokeTokens({ userId: user._id, amount: 30000, memo: '订单 X 退款' });
    expect(r.clawed).toBe(30000);
    expect(r.shortfall).toBe(0);
    const w = await walletOf(user._id);
    expect(w.addon).toBe(20000); // addon 先扣
    expect(w.plan).toBe(20000); // plan 没动
    expect(w.debt).toBe(0);
    expect(w.debtSince).toBeNull();
  });

  it('扣减顺序是 addon → plan（与消费相反）：plan 月底作废，先扣它等于没扣', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 20000, 10000);
    await wallet.revokeTokens({ userId: user._id, amount: 25000 });
    const w = await walletOf(user._id);
    expect(w.addon).toBe(0);
    expect(w.plan).toBe(5000);
  });

  it('余额不足：余额归零，差额转欠额并冻结', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 20000, 10000);
    const r = await wallet.revokeTokens({ userId: user._id, amount: 80000, memo: '订单 IH123 退款' });
    expect(r.clawed).toBe(30000);
    expect(r.shortfall).toBe(50000);
    const w = await walletOf(user._id);
    expect(w.plan + w.addon).toBe(0);
    expect(w.debt).toBe(50000);
    expect(w.debtSince).toBeInstanceOf(Date);
  });

  it('余额为 0：全额转欠额', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    const r = await wallet.revokeTokens({ userId: user._id, amount: 40000 });
    expect(r.clawed).toBe(0);
    expect((await walletOf(user._id)).debt).toBe(40000);
  });

  it('记账形状：play_refund 记负 delta，debt_incurred 记 delta=0 + costTokens（账本要和余额对得上）', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 20000, 10000);
    await wallet.revokeTokens({ userId: user._id, amount: 80000 });
    const rows = await TokenLedger.find({ user: user._id }).sort({ createdAt: 1 }).lean();
    const refund = rows.find((r) => r.reason === 'play_refund');
    const incurred = rows.find((r) => r.reason === 'debt_incurred');
    expect(refund.delta).toBe(-30000);
    expect(refund.balanceAfter).toBe(0);
    expect(incurred.delta).toBe(0);
    expect(incurred.costTokens).toBe(50000);
    expect(incurred.balanceAfter).toBe(0);
  });

  it('★ 逐笔 delta 累加 ≡ 最后一行 balanceAfter（欠额那两行不许破坏这条）', async () => {
    // 这条只走真实路径（发放 → 回收 → 充值抵扣），不用 setBalance 直接改库，
    // 否则账本里天然少一行、对不上的是测试而不是代码。
    const { user } = await makeUser();
    const granted = (await wallet.ensureWallet(user._id)).plan; // 免费档当月额度
    await wallet.revokeTokens({ userId: user._id, amount: granted + 50000 });
    await wallet.credit(user._id, 200000, 'recharge');
    const rows = await TokenLedger.find({ user: user._id }).sort({ createdAt: 1, _id: 1 }).lean();
    const sum = rows.reduce((n, r) => n + r.delta, 0);
    expect(sum).toBe(rows[rows.length - 1].balanceAfter);
    expect(sum).toBe(150000);
  });

  it('★ 两笔入账并发抵同一笔欠额，只能抵一次（守卫要带 debt 维度）', async () => {
    // 触发条件是「余额 ≥ 2×欠额」。不守 debt 的话两条都能过：各扣 100 万，而管道里的
    // $max:[0, debt-pay] 把第二次夹到 0 —— 静默成功，用户白少 100 万，两条流水还各自自洽。
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 1_000_000 });
    await setBalance(user._id, 0, 5_000_000);
    await Promise.all([wallet.repayDebt(user._id, '并发 A'), wallet.repayDebt(user._id, '并发 B')]);
    const w = await walletOf(user._id);
    expect(w.debt).toBe(0);
    expect(w.plan + w.addon).toBe(4_000_000); // 只抵了一次
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'debt_repaid' })).toBe(1);
  });

  it('★ 管理员免除与在途抵扣撞车：不会先免除再拿余额去还一笔已经不存在的欠额', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 500_000 });
    await setBalance(user._id, 0, 5_000_000);
    await Promise.all([wallet.forgiveDebt(user._id, '管理员免除'), wallet.repayDebt(user._id, '同时充值抵扣')]);
    const w = await walletOf(user._id);
    expect(w.debt).toBe(0);
    // 要么免除（余额不动）、要么抵扣（扣 50 万），**不能两件事都发生**
    expect([5_000_000, 4_500_000]).toContain(w.plan + w.addon);
    const repaid = await TokenLedger.countDocuments({ user: user._id, reason: 'debt_repaid' });
    const forgiven = await TokenLedger.countDocuments({ user: user._id, reason: 'debt_forgiven' });
    expect(repaid + forgiven).toBe(1);
  });

  it('★ 回收与并发入账撞车：差额不许被放大，也不许写出 delta 为正的回收流水', async () => {
    // 老写法是「先独立读一次算 beforeTotal、再拿 after 作差」，那个窗口里的任何并发入账
    // 都会让 clawed 变成负数 ⇒ shortfall 被放大成「退款额 + 充值额」⇒ 给没欠钱的人挂欠额并冻结。
    const { user } = await makeUser();
    const N = 100_000;
    await setBalance(user._id, 0, N);
    const [r] = await Promise.all([
      wallet.revokeTokens({ userId: user._id, amount: N, memo: '退款' }),
      ...Array.from({ length: 6 }, (_, i) => wallet.credit(user._id, 50_000, 'grant', `并发入账 ${i}`)),
    ]);
    expect(r.clawed).toBeGreaterThanOrEqual(0);
    expect(r.clawed).toBeLessThanOrEqual(N);
    expect(r.shortfall).toBeGreaterThanOrEqual(0);
    expect(r.shortfall).toBeLessThanOrEqual(N); // 老写法这里会超
    expect((await walletOf(user._id)).debt).toBeLessThanOrEqual(N);
    const refunds = await TokenLedger.find({ user: user._id, reason: 'play_refund' }).lean();
    for (const row of refunds) expect(row.delta).toBeLessThanOrEqual(0); // 回收永远不是入账
  });

  it('并发回收与扣费不会把 addon 扣成负数', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 10000);
    await Promise.all([
      wallet.revokeTokens({ userId: user._id, amount: 8000 }),
      wallet.debit(user._id, 8000, 'concurrent spend'),
    ]);
    const w = await walletOf(user._id);
    expect(w.addon).toBeGreaterThanOrEqual(0);
    expect(w.plan).toBeGreaterThanOrEqual(0);
  });
});

describe('测试购买的豁免（R-12）', () => {
  it('isTest 订单：回收照做，但差额不转欠额、不冻结', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 10000);
    const r = await wallet.revokeTokens({ userId: user._id, amount: 90000, isTest: true, memo: '测试购买自动退款' });
    expect(r.clawed).toBe(10000);
    expect(r.shortfall).toBe(80000);
    expect(r.exempt).toBe(true);
    const w = await walletOf(user._id);
    expect(w.debt).toBe(0);
    // 豁免也要留痕，否则事后看不出「这笔差额为什么没转欠额」
    const rows = await TokenLedger.find({ user: user._id, reason: 'debt_incurred' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].isTest).toBe(true);
    expect(rows[0].costTokens).toBe(80000);
  });

  it('回收那一行也打 isTest：营收统计要能把测试购买整条排除', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 10000);
    await wallet.revokeTokens({ userId: user._id, amount: 5000, isTest: true });
    const row = await TokenLedger.findOne({ user: user._id, reason: 'play_refund' }).lean();
    expect(row.isTest).toBe(true);
  });
});

describe('抵债（R-9/R-10）', () => {
  it('充值先抵欠额，余下可用，自动解冻', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 50000 });
    const after = await wallet.credit(user._id, 200000, 'recharge', '订单 Y');
    expect(after.debt).toBe(0);
    expect(after.frozen).toBe(false);
    expect(after.plan + after.addon).toBe(150000);
    const w = await walletOf(user._id);
    expect(w.debtSince).toBeNull();
    const repaid = await TokenLedger.findOne({ user: user._id, reason: 'debt_repaid' }).lean();
    expect(repaid.delta).toBe(-50000);
    expect(repaid.balanceAfter).toBe(150000);
  });

  it('充的不够就只抵一部分，仍然冻结', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 50000 });
    const after = await wallet.credit(user._id, 20000, 'recharge');
    expect(after.debt).toBe(20000 === 0 ? 0 : 30000);
    expect(after.frozen).toBe(true);
    expect(after.plan + after.addon).toBe(0);
  });

  it('买套餐也抵债', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 1000 });
    const after = await wallet.buyPlan(user._id, 'pro');
    expect(after.debt).toBe(0);
  });

  it('★ 跨月刷新不抵债：否则等到下月 1 号欠额自动清零，退款套利成本归零', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 50000 });
    // 把 cycle 拨回上个月，再触达一次
    await User.updateOne({ _id: user._id }, { $set: { 'tokenWallet.cycle': '2000-01' } });
    const after = await wallet.ensureWallet(user._id);
    expect(after.debt).toBe(50000);
    expect(after.frozen).toBe(true);
    expect(after.plan).toBeGreaterThan(0); // 额度确实发了
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'debt_repaid' })).toBe(0);
  });

  it('★ 方舟退款（ark_refund）也不抵债：那是我们退给他的，不是他付的', async () => {
    const { user } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 50000 });
    const after = await wallet.credit(user._id, 30000, 'ark_refund', '上游 429');
    expect(after.debt).toBe(50000);
    expect(after.plan + after.addon).toBe(30000);
  });
});

describe('冻结（R-7/R-8）', () => {
  it('欠额 > 0 时调 AI：403 WALLET_FROZEN（不是 402），响应体带具体数字', async () => {
    const { user, token } = await makeUser();
    await setBalance(user._id, 500000, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 600000 });
    const res = await request(app)
      .post('/api/ark/images/generations')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'doubao-seedream-4-0-250828', prompt: '一只猫' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WALLET_FROZEN');
    expect(res.body.debt).toBe(100000);
    expect(String(res.body.message)).toContain('100000');
  });

  it('冻结期间一分钱都不扣（拒在 debit 之前）', async () => {
    const { user, token } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 1000 });
    await request(app)
      .post('/api/ark/images/generations')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'doubao-seedream-4-0-250828', prompt: '一只猫' });
    expect(await TokenLedger.countDocuments({ user: user._id, reason: 'ark_spend' })).toBe(0);
  });

  it('抵扣解冻之后又能用了（断言的是「闸真的开了」，不是「没返回 403」）', async () => {
    const { user, token } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 1000 });
    await wallet.credit(user._id, 500000, 'recharge');
    // ★ 这一发会真的出网（本 suite 没 mock fetch），所以**不能**用 `not.toBe(403)` 当断言 ——
    //   出网必然失败、状态码必然不是 403，那条断言恒真。真正要证明的是「闸开了、钱扣了」：
    //   preAuthorize 通过之后 debit 一定先发生，失败再由 refundUnaccepted 退回来。
    await request(app)
      .post('/api/ark/images/generations')
      .set('Authorization', `Bearer ${token}`)
      .send({ model: 'doubao-seedream-4-0-250828', prompt: '一只猫' });
    const spend = await TokenLedger.findOne({ user: user._id, reason: 'ark_spend' }).lean();
    expect(spend).toBeTruthy(); // 冻结时这一条根本不会存在
    expect((await walletOf(user._id)).debt).toBe(0);
  });

  it('钱包快照与响应头把冻结状态下发出去（客户端镜像空时不许自己猜）', async () => {
    const { user, token } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 7000 });
    const res = await request(app).get('/api/me/wallet').set('Authorization', `Bearer ${token}`);
    expect(res.body.wallet.debt).toBe(7000);
    expect(res.body.wallet.frozen).toBe(true);
  });
});

describe('管理员免除（R-13）', () => {
  it('debt 归 0，并落一条 debt_forgiven（余额不动）', async () => {
    const { user } = await makeUser();
    const admin = await makeUser('admin');
    await setBalance(user._id, 1000, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 61000 });
    const res = await request(app).post(`/api/admin/users/${user._id}/forgive-debt`).set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.wallet.debt).toBe(0);
    expect(res.body.wallet.frozen).toBe(false);
    const row = await TokenLedger.findOne({ user: user._id, reason: 'debt_forgiven' }).lean();
    expect(row.delta).toBe(0);
    expect(row.costTokens).toBe(60000);
    expect((await walletOf(user._id)).plan + (await walletOf(user._id)).addon).toBe(0);
  });

  it('普通用户免不了自己的债', async () => {
    const { user, token } = await makeUser();
    await setBalance(user._id, 0, 0);
    await wallet.revokeTokens({ userId: user._id, amount: 1000 });
    const res = await request(app).post(`/api/admin/users/${user._id}/forgive-debt`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect((await walletOf(user._id)).debt).toBe(1000);
  });
});

describe('老账号（没有 debt 字段）', () => {
  it('读成 0 而不是 NaN，也不会被当成冻结', async () => {
    const { user, token } = await makeUser();
    await wallet.ensureWallet(user._id);
    await User.updateOne({ _id: user._id }, { $unset: { 'tokenWallet.debt': '', 'tokenWallet.debtSince': '' } });
    const res = await request(app).get('/api/me/wallet').set('Authorization', `Bearer ${token}`);
    expect(res.body.wallet.debt).toBe(0);
    expect(res.body.wallet.frozen).toBe(false);
    expect(wallet.debtOf({ debt: undefined })).toBe(0);
  });
});
