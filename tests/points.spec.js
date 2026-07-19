// tests/points.spec.js
// 覆盖：赏金虚拟点数 + 双边记账。
//
// ★这个 spec 的重点不是「接口通不通」，而是那三条【错了不会报错，只会悄悄多印钱/少给人钱】
//   的硬不变量。三个 describe 分别钉死一条：
//     I1 只有注册赠送能印钱  → sum(所有 delta) === sum(signup 的 delta)
//     I2 并发不超付          → Promise.all 并发审批同一悬赏，不得超名额/透支托管
//     I3 退款幂等            → 连点两次关闭只退一次
//   删这些用例前请先想清楚：没有它们，双花和重复退款回归时【测试全绿】。
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  // dropDatabase 会把索引一起删掉，而 {user, reason:"signup"} 的唯一索引正是
  // 注册赠送幂等的最后一道闸 —— 不重建的话「signup 幂等」那条用例就是在裸奔。
  const PointsLedger = require('../src/models/PointsLedger');
  await PointsLedger.syncIndexes();
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

let seq = 0;
/** 走真实注册路径（POST /api/auth/register）建号 —— 这样 signup 分录也是真实产生的 */
async function registerUser() {
  seq += 1;
  const name = `pt${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: name, email: `${name}@test.local`, password: 'secret123' })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

function bountyBody(overrides = {}) {
  return {
    title: '测试悬赏',
    description: '',
    reward: 100,
    platform: 'weibo',
    targetUrl: 'https://example.com/post/1',
    tags: [],
    slots: 1,
    ...overrides,
  };
}

async function createBounty(token, overrides = {}) {
  const res = await request(app)
    .post('/api/bounties')
    .set(authHeader(token))
    .send(bountyBody(overrides))
    .expect(201);
  return res.body.bounty;
}

async function submit(token, bountyId, text = '我发言了') {
  const res = await request(app)
    .post(`/api/bounties/${bountyId}/submissions`)
    .set(authHeader(token))
    .send({ speechText: text })
    .expect(201);
  return res.body.submission;
}

async function pointsOf(userId) {
  const User = require('../src/models/User');
  const u = await User.findById(userId).select('points').lean();
  return Number(u.points);
}

async function ledgerSum(match = {}) {
  const PointsLedger = require('../src/models/PointsLedger');
  const rows = await PointsLedger.aggregate([
    { $match: match },
    { $group: { _id: null, sum: { $sum: '$delta' } } },
  ]);
  return rows.length ? rows[0].sum : 0;
}

/** 某悬赏的托管余额，【账本口径】= 该 bounty 下所有 user:null 分录之和 */
async function escrowFromLedger(bountyId) {
  return ledgerSum({ bounty: new mongoose.Types.ObjectId(String(bountyId)), user: null });
}

/**
 * I1 的对账式：全库 sum(所有 delta) 恒等于 sum(所有 signup 的 delta)。
 * 意思是：除了注册赠送，没有任何一个地方能凭空造出或凭空销毁点数。
 */
async function expectOnlySignupMintsMoney() {
  const all = await ledgerSum({});
  const signup = await ledgerSum({ reason: 'signup' });
  expect(all).toBe(signup);
  return { all, signup };
}

/** 每个用户的余额都必须等于他自己所有分录之和（余额 ↔ 账本对得上） */
async function expectBalancesMatchLedger() {
  const User = require('../src/models/User');
  const users = await User.find({}).select('_id points').lean();
  for (const u of users) {
    const sum = await ledgerSum({ user: u._id });
    expect({ user: String(u._id), points: Number(u.points) }).toEqual({ user: String(u._id), points: sum });
  }
}

// ══════════════════════════════════════════════════════════════════
describe('I1 · 只有注册赠送能印钱', () => {
  test('注册赠送 1000 点：余额、分录、balanceAfter 三者一致', async () => {
    const alice = await registerUser();

    const res = await request(app).get('/api/me/points').set(authHeader(alice.token)).expect(200);
    expect(res.body).toEqual({ ok: true, points: 1000 });

    const PointsLedger = require('../src/models/PointsLedger');
    const rows = await PointsLedger.find({ user: alice.userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(1000);
    expect(rows[0].reason).toBe('signup');
    expect(rows[0].balanceAfter).toBe(1000);
    expect(rows[0].bounty).toBe(null);

    await expectOnlySignupMintsMoney();
  });

  test('注册赠送幂等：同一个 user 不可能有第二条 signup 分录', async () => {
    const alice = await registerUser();
    const { grantSignupBonus } = require('../src/services/points.service');

    // 直接再调两次（模拟重试/并发）
    expect(await grantSignupBonus(alice.userId)).toBe(false);
    await Promise.all([grantSignupBonus(alice.userId), grantSignupBonus(alice.userId)]);

    const PointsLedger = require('../src/models/PointsLedger');
    expect(await PointsLedger.countDocuments({ user: alice.userId, reason: 'signup' })).toBe(1);
    expect(await pointsOf(alice.userId)).toBe(1000);
    await expectOnlySignupMintsMoney();
  });

  test('跑完一整串操作（发布/审批/关闭/删除）后，全库 sum(delta) 仍恒等于 sum(signup)', async () => {
    const poster = await registerUser();
    const h1 = await registerUser();
    const h2 = await registerUser();

    // 发布 → 审批一个 → 关闭退款
    const b1 = await createBounty(poster.token, { reward: 100, slots: 2 });
    const s1 = await submit(h1.token, b1._id);
    await submit(h2.token, b1._id);
    await request(app)
      .post(`/api/bounties/${b1._id}/submissions/${s1._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);
    await request(app)
      .post(`/api/bounties/${b1._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);

    // 发布 → 改赏金（补扣+退还两条路径都走到）→ 直接删除
    const b2 = await createBounty(poster.token, { reward: 50, slots: 1 });
    await request(app).put(`/api/bounties/${b2._id}`).set(authHeader(poster.token)).send({ reward: 120 }).expect(200);
    await request(app).put(`/api/bounties/${b2._id}`).set(authHeader(poster.token)).send({ reward: 30 }).expect(200);
    await request(app).delete(`/api/bounties/${b2._id}`).set(authHeader(poster.token)).expect(200);

    // 发布 → 名额满自动 completed
    const b3 = await createBounty(poster.token, { reward: 10, slots: 1 });
    const s3 = await submit(h2.token, b3._id);
    await request(app)
      .post(`/api/bounties/${b3._id}/submissions/${s3._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);

    const { all, signup } = await expectOnlySignupMintsMoney();
    expect(signup).toBe(3000); // 3 个注册赠送
    expect(all).toBe(3000);

    // 余额和账本必须对得上
    await expectBalancesMatchLedger();

    // 每一分钱都有去处：3 个人的余额之和 = 印出来的总量 - 还锁在托管里的
    const total = (await pointsOf(poster.userId)) + (await pointsOf(h1.userId)) + (await pointsOf(h2.userId));
    const stillHeld = await escrowFromLedger(b1._id);
    expect(total + stillHeld).toBe(3000);
  });

  test('余额不足 → 400「点数不足」，且悬赏【不会】被创建（不能扣不到款还把牌子挂出去）', async () => {
    const poster = await registerUser();
    const Bounty = require('../src/models/Bounty');

    const res = await request(app)
      .post('/api/bounties')
      .set(authHeader(poster.token))
      .send(bountyBody({ reward: 600, slots: 2 })) // 1200 > 1000
      .expect(400);
    expect(res.body.message).toBe('点数不足');

    expect(await Bounty.countDocuments({})).toBe(0);
    expect(await pointsOf(poster.userId)).toBe(1000);
    await expectOnlySignupMintsMoney();
  });

  test('发布悬赏：托管一对分录和为零，Bounty.escrowPoints 与账本口径一致', async () => {
    const poster = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 3 });

    expect(await pointsOf(poster.userId)).toBe(700); // 1000 - 300
    expect(b.escrowPoints).toBe(300);
    expect(await escrowFromLedger(b._id)).toBe(300);

    const PointsLedger = require('../src/models/PointsLedger');
    const holds = await PointsLedger.find({ bounty: b._id, reason: 'bounty_hold' }).lean();
    expect(holds).toHaveLength(2);
    expect(holds.reduce((a, e) => a + e.delta, 0)).toBe(0); // 成对且和为零
    await expectOnlySignupMintsMoney();
  });

  test('托管分录（user:null）不出现在任何用户的流水里', async () => {
    const poster = await registerUser();
    await createBounty(poster.token, { reward: 100, slots: 1 });

    const res = await request(app).get('/api/me/points/ledger').set(authHeader(poster.token)).expect(200);
    expect(res.body.total).toBe(2); // signup + 自己那条 hold 出账
    for (const e of res.body.entries) {
      expect(e.delta).not.toBe(100); // 托管账户那条 +100 不该露出来
    }
    expect(res.body.entries.map((e) => e.reason).sort()).toEqual(['bounty_hold', 'signup']);
    expect(res.body.entries.find((e) => e.reason === 'bounty_hold').delta).toBe(-100);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('I2 · 并发不超付', () => {
  test('并发审批同一悬赏的 5 个提交、只有 2 个名额：恰好通过 2 个，托管不为负', async () => {
    const poster = await registerUser();
    const hunters = [];
    for (let i = 0; i < 5; i += 1) hunters.push(await registerUser());

    const b = await createBounty(poster.token, { reward: 100, slots: 2 }); // 托管 200
    expect(await pointsOf(poster.userId)).toBe(800);

    const subs = [];
    for (const h of hunters) subs.push(await submit(h.token, b._id, `hunter ${h.username}`));

    // ★并发：5 个审批同时打进来。读-改-写的实现会让多个请求同时看到 approvedCount=0、
    //   escrowPoints=200，于是全部放行 —— 超名额发放 + 托管透支。
    const results = await Promise.all(
      subs.map((s) =>
        request(app)
          .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
          .set(authHeader(poster.token))
          .send({ status: 'approved' })
      )
    );

    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status === 400);
    expect(ok).toHaveLength(2);
    expect(rejected).toHaveLength(3);

    const Bounty = require('../src/models/Bounty');
    const BountySubmission = require('../src/models/BountySubmission');
    const fresh = await Bounty.findById(b._id).lean();

    expect(fresh.approvedCount).toBe(2); // 不超名额
    expect(fresh.escrowPoints).toBe(0); // 托管刚好用完
    expect(fresh.escrowPoints).toBeGreaterThanOrEqual(0); // ★永不为负
    expect(await escrowFromLedger(b._id)).toBe(0); // 账本口径同样为 0，且从未透支
    expect(fresh.status).toBe('completed');

    // 恰好 2 条 approved，且被拒的那 3 条状态回滚干净（没有停在 approved 上）
    expect(await BountySubmission.countDocuments({ bounty: b._id, status: 'approved' })).toBe(2);
    expect(await BountySubmission.countDocuments({ bounty: b._id, status: 'pending' })).toBe(3);

    // 实际发放总额 = 200，一点不多
    const paidOut = await ledgerSum({
      bounty: new mongoose.Types.ObjectId(String(b._id)),
      reason: 'bounty_reward',
      user: { $ne: null },
    });
    expect(paidOut).toBe(200);

    // 每个猎人要么没拿到（1000），要么拿到整 100（1100）；没有人拿两次
    const balances = [];
    for (const h of hunters) balances.push(await pointsOf(h.userId));
    expect(balances.filter((p) => p === 1100)).toHaveLength(2);
    expect(balances.filter((p) => p === 1000)).toHaveLength(3);

    expect(await pointsOf(poster.userId)).toBe(800); // 发布者没有被多扣

    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('并发重复审批【同一条】提交：只入账一次（不双花）', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 3 }); // 托管 300，名额够，闸门挡不住重复
    const s = await submit(hunter.token, b._id);

    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        request(app)
          .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
          .set(authHeader(poster.token))
          .send({ status: 'approved' })
      )
    );
    for (const r of results) expect(r.status).toBe(200); // 幂等，不报错

    expect(await pointsOf(hunter.userId)).toBe(1100); // ★只入账一次
    const Bounty = require('../src/models/Bounty');
    const fresh = await Bounty.findById(b._id).lean();
    expect(fresh.approvedCount).toBe(1);
    expect(fresh.escrowPoints).toBe(200);
    expect(await escrowFromLedger(b._id)).toBe(200);

    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('托管不足时拒绝审批，不透支（老悬赏 escrowPoints=0 的情形）', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 1 });
    const s = await submit(hunter.token, b._id);

    // 模拟点数系统上线前就存在的悬赏：有 reward，但从没托管过点数
    const Bounty = require('../src/models/Bounty');
    await Bounty.updateOne({ _id: b._id }, { $set: { escrowPoints: 0 } });

    const res = await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(400);
    expect(res.body.message).toBe('该悬赏的托管点数不足，无法发放赏金');

    expect(await pointsOf(hunter.userId)).toBe(1000); // 没发出去
    const fresh = await Bounty.findById(b._id).lean();
    expect(fresh.escrowPoints).toBe(0); // ★没被扣成 -100
    expect(fresh.approvedCount).toBe(0);

    const BountySubmission = require('../src/models/BountySubmission');
    const freshSub = await BountySubmission.findById(s._id).lean();
    expect(freshSub.status).toBe('pending'); // 占坑已回滚
  });

  test('approved 是终态：不能再改回 rejected（点数已入账，撤不回来）', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 2 });
    const s = await submit(hunter.token, b._id);

    await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);

    const res = await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'rejected' })
      .expect(400);
    expect(res.body.message).toBe('该提交已审批通过并发放了点数，不能再改为拒绝');

    expect(await pointsOf(hunter.userId)).toBe(1100); // 没被倒扣
    await expectOnlySignupMintsMoney();
  });

  test('审批入账金额写进 awardedPoints；事后改 reward 不会篡改已入账的数', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 2 });
    const s = await submit(hunter.token, b._id);

    const res = await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);
    expect(res.body.submission.awardedPoints).toBe(100);

    await request(app).put(`/api/bounties/${b._id}`).set(authHeader(poster.token)).send({ reward: 5 }).expect(200);

    const after = await request(app).get(`/api/bounties/${b._id}`).set(authHeader(hunter.token)).expect(200);
    expect(after.body.bounty.mySubmission.awardedPoints).toBe(100); // 仍是账本真值
    expect(await pointsOf(hunter.userId)).toBe(1100);
    await expectOnlySignupMintsMoney();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('I3 · 退款幂等', () => {
  test('连点两次关闭：只退一次款', async () => {
    const poster = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 2 }); // 托管 200
    expect(await pointsOf(poster.userId)).toBe(800);

    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);
    expect(await pointsOf(poster.userId)).toBe(1000);

    // ★第二次点击：不得再退一次（再退就是凭空印钱）
    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);
    expect(await pointsOf(poster.userId)).toBe(1000);

    // 第三次、以及「标记完成」也一样
    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'completed' })
      .expect(200);
    expect(await pointsOf(poster.userId)).toBe(1000);

    const PointsLedger = require('../src/models/PointsLedger');
    const refunds = await PointsLedger.find({ bounty: b._id, reason: 'bounty_refund' }).lean();
    expect(refunds).toHaveLength(2); // 恰好一对（一次退款），不是两对
    expect(refunds.reduce((a, e) => a + e.delta, 0)).toBe(0);

    expect(await escrowFromLedger(b._id)).toBe(0);
    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('并发连点关闭（Promise.all）：仍然只退一次', async () => {
    const poster = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 3 }); // 托管 300
    expect(await pointsOf(poster.userId)).toBe(700);

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        request(app).post(`/api/bounties/${b._id}/status`).set(authHeader(poster.token)).send({ status: 'closed' })
      )
    );

    expect(await pointsOf(poster.userId)).toBe(1000); // ★不是 1300/1600/…

    const PointsLedger = require('../src/models/PointsLedger');
    expect(await PointsLedger.countDocuments({ bounty: b._id, reason: 'bounty_refund' })).toBe(2);
    const Bounty = require('../src/models/Bounty');
    const fresh = await Bounty.findById(b._id).lean();
    expect(fresh.escrowPoints).toBe(0);
    expect(fresh.refundedAt).toBeInstanceOf(Date);

    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('部分发放后关闭：只退【剩余】托管，已发出去的不追回', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 3 }); // 托管 300
    const s = await submit(hunter.token, b._id);
    await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);

    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);
    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);

    expect(await pointsOf(poster.userId)).toBe(900); // 700 + 退还 200
    expect(await pointsOf(hunter.userId)).toBe(1100); // 已发放的 100 不动
    expect(await escrowFromLedger(b._id)).toBe(0);
    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('剩余为 0 时不写退款分录（名额刚好用完）', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 1 }); // 托管 100
    const s = await submit(hunter.token, b._id);
    await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(200);

    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);

    const PointsLedger = require('../src/models/PointsLedger');
    expect(await PointsLedger.countDocuments({ bounty: b._id, reason: 'bounty_refund' })).toBe(0);
    expect(await pointsOf(poster.userId)).toBe(900);
    await expectOnlySignupMintsMoney();
  });

  test('已结算的悬赏不能重开、不能再审批、不能再改赏金', async () => {
    const poster = await registerUser();
    const hunter = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 2 });
    const s = await submit(hunter.token, b._id);

    await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'closed' })
      .expect(200);
    expect(await pointsOf(poster.userId)).toBe(1000);

    const reopen = await request(app)
      .post(`/api/bounties/${b._id}/status`)
      .set(authHeader(poster.token))
      .send({ status: 'open' })
      .expect(400);
    expect(reopen.body.message).toBe('该悬赏已结算并退还托管点数，不能重新开启');

    const review = await request(app)
      .post(`/api/bounties/${b._id}/submissions/${s._id}/review`)
      .set(authHeader(poster.token))
      .send({ status: 'approved' })
      .expect(400);
    expect(review.body.message).toBe('该悬赏已结算并退还托管点数，无法再审批通过');
    expect(await pointsOf(hunter.userId)).toBe(1000); // 一点没发出去

    const edit = await request(app)
      .put(`/api/bounties/${b._id}`)
      .set(authHeader(poster.token))
      .send({ reward: 500 })
      .expect(400);
    expect(edit.body.message).toBe('该悬赏已结算并退还托管点数，不能再修改赏金点数或名额');

    expect(await pointsOf(poster.userId)).toBe(1000); // 上面三次失败都没动过钱
    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('删除悬赏会把托管退回发布者（不能让点数跟着悬赏一起消失）', async () => {
    const poster = await registerUser();
    const b = await createBounty(poster.token, { reward: 100, slots: 4 }); // 托管 400
    expect(await pointsOf(poster.userId)).toBe(600);

    await request(app).delete(`/api/bounties/${b._id}`).set(authHeader(poster.token)).expect(200);

    expect(await pointsOf(poster.userId)).toBe(1000);
    expect(await escrowFromLedger(b._id)).toBe(0);
    await expectOnlySignupMintsMoney(); // 分录留着（历史），对账式照样成立
  });
});

// ══════════════════════════════════════════════════════════════════
describe('接口 · /api/me/points', () => {
  test('未登录 → 401', async () => {
    await request(app).get('/api/me/points').expect(401);
    await request(app).get('/api/me/points/ledger').expect(401);
  });

  test('流水分页 + 只看自己的', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    await createBounty(alice.token, { reward: 10, slots: 1 });
    await createBounty(alice.token, { reward: 20, slots: 1 });

    const p1 = await request(app).get('/api/me/points/ledger?page=1&limit=2').set(authHeader(alice.token)).expect(200);
    expect(p1.body.total).toBe(3); // signup + 2 笔托管
    expect(p1.body.entries).toHaveLength(2);
    expect(p1.body.totalPages).toBe(2);
    expect(p1.body.entries[0]).toMatchObject({ reason: 'bounty_hold', delta: -20, balanceAfter: 970 });

    const p2 = await request(app).get('/api/me/points/ledger?page=2&limit=2').set(authHeader(alice.token)).expect(200);
    expect(p2.body.entries).toHaveLength(1);
    expect(p2.body.entries[0].reason).toBe('signup');

    // bob 只看得到自己的
    const bobLedger = await request(app).get('/api/me/points/ledger').set(authHeader(bob.token)).expect(200);
    expect(bobLedger.body.total).toBe(1);
    expect(bobLedger.body.entries[0].reason).toBe('signup');
  });

  test('backfill 前（points 字段缺失）余额读作 0，与写入侧口径一致 —— 不兜底成 1000', async () => {
    const alice = await registerUser();
    const User = require('../src/models/User');
    await User.updateOne({ _id: alice.userId }, { $unset: { points: '' } });

    const res = await request(app).get('/api/me/points').set(authHeader(alice.token)).expect(200);
    expect(res.body.points).toBe(0);

    // 写入侧同样认为「没有余额」：发布悬赏会被拒
    const create = await request(app)
      .post('/api/bounties')
      .set(authHeader(alice.token))
      .send(bountyBody({ reward: 1, slots: 1 }))
      .expect(400);
    expect(create.body.message).toBe('点数不足');

    // 跑迁移后恢复正常
    await User.updateMany({ points: { $exists: false } }, { $set: { points: 1000 } });
    const after = await request(app).get('/api/me/points').set(authHeader(alice.token)).expect(200);
    expect(after.body.points).toBe(1000);
  });
});
