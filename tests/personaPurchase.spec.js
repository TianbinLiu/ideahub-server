// tests/personaPurchase.spec.js
// 覆盖：人格付费购买（赏金点数）。
//
// ★与 points.spec 同一立场：重点不是「接口通不通」，而是那些【错了不会报错，
//   只会悄悄多印钱/少给人钱/白嫖】的路径：
//   - 三条分录和为零（买家 -price / 创作者 +price-fee / 平台 +fee），I1 对账式不破
//   - 并发双击只扣一次款（PersonaPurchase 唯一索引 claim）
//   - 余额不足时【什么都不落】：无购买记录、无分录、余额不动
//   - 未购买不得绑定进情景（防 API 直连白嫖）；购买后立即可绑定
//   - 装备（equip）同样被付费门挡住
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
  // dropDatabase 连索引一起删；signup 幂等与购买防双花都靠唯一索引，必须重建
  const PointsLedger = require('../src/models/PointsLedger');
  const PersonaPurchase = require('../src/models/PersonaPurchase');
  await PointsLedger.syncIndexes();
  await PersonaPurchase.syncIndexes();
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `pp${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username: name, email: `${name}@test.local`, password: 'secret123' })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

async function createPersona(token, overrides = {}) {
  const res = await request(app)
    .post('/api/personas')
    .set(authHeader(token))
    .send({
      name: '付费测试人格',
      description: '测试用',
      coverEmoji: '💰',
      tags: ['测试'],
      style: { summary: '说话直接', catchphrases: ['就这'], stats: [], stanceHint: '' },
      shared: true,
      price: 100,
      ...overrides,
    })
    .expect(201);
  return res.body.persona;
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

async function expectOnlySignupMintsMoney() {
  const all = await ledgerSum({});
  const signup = await ledgerSum({ reason: 'signup' });
  expect(all).toBe(signup);
}

async function expectBalancesMatchLedger() {
  const User = require('../src/models/User');
  const users = await User.find({}).select('_id points').lean();
  for (const u of users) {
    const sum = await ledgerSum({ user: u._id });
    expect({ user: String(u._id), points: Number(u.points) }).toEqual({ user: String(u._id), points: sum });
  }
}

// ══════════════════════════════════════════════════════════════════
describe('人格购买 · 记账正确性', () => {
  test('购买成功：买家-100、创作者+95、平台抽成5，对账式与余额↔账本都成立', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    const res = await request(app)
      .post(`/api/personas/${persona._id}/purchase`)
      .set(authHeader(bob.token))
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, purchased: true, alreadyOwned: false, price: 100 });
    expect(res.body.balance).toBe(900);

    expect(await pointsOf(bob.userId)).toBe(900);
    expect(await pointsOf(alice.userId)).toBe(1095);

    // 平台抽成分录：user:null + persona 引用，delta=5
    const feeSum = await ledgerSum({
      user: null,
      persona: new mongoose.Types.ObjectId(String(persona._id)),
      reason: 'persona_fee',
    });
    expect(feeSum).toBe(5);

    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('重复购买幂等：第二次不扣款、不写分录', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    await request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)).expect(200);
    const again = await request(app)
      .post(`/api/personas/${persona._id}/purchase`)
      .set(authHeader(bob.token))
      .expect(200);
    expect(again.body.alreadyOwned).toBe(true);

    expect(await pointsOf(bob.userId)).toBe(900);
    const PointsLedger = require('../src/models/PointsLedger');
    expect(
      await PointsLedger.countDocuments({ persona: persona._id, reason: 'persona_buy' })
    ).toBe(1);
    await expectOnlySignupMintsMoney();
  });

  test('并发双击：只扣一次款、只有一条已结算记录，且没有人拿到假成功', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)),
      request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)),
    ]);
    // 赢家 200；输家撞到 pending claim 时是 400「处理中」（撞到已结算则 200 alreadyOwned）——
    // 两者都合法，但【至少一个成功】且绝不能双扣
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 400).toBe(true);
    expect(statuses).toContain(200);

    expect(await pointsOf(bob.userId)).toBe(900); // 只扣了一次
    const PersonaPurchase = require('../src/models/PersonaPurchase');
    expect(await PersonaPurchase.countDocuments({ user: bob.userId, persona: persona._id, settledAt: { $ne: null } })).toBe(1);
    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('余额不足 + 并发双击：没有任何请求拿到成功，也不留任何记录（假成功回归钉子）', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 5000 });

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)),
      request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)),
    ]);
    // 修复前：输家撞唯一索引会拿到假的 200「已购」。修复后：pending 不算已购，两个都必须失败。
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);

    expect(await pointsOf(bob.userId)).toBe(1000);
    const PersonaPurchase = require('../src/models/PersonaPurchase');
    expect(await PersonaPurchase.countDocuments({ user: bob.userId })).toBe(0);
    await expectOnlySignupMintsMoney();
  });

  test('价格钉住（TOCTOU）：expectedPrice 与当前价不符 → 400 且不扣款', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    // 模拟「确认弹层还开着，作者已把价格改成 500」
    await request(app)
      .put(`/api/personas/${persona._id}`)
      .set(authHeader(alice.token))
      .send({ price: 500 })
      .expect(200);

    await request(app)
      .post(`/api/personas/${persona._id}/purchase`)
      .set(authHeader(bob.token))
      .send({ expectedPrice: 100 })
      .expect(400);
    expect(await pointsOf(bob.userId)).toBe(1000);

    // 按最新价格确认则成功
    const ok = await request(app)
      .post(`/api/personas/${persona._id}/purchase`)
      .set(authHeader(bob.token))
      .send({ expectedPrice: 500 })
      .expect(200);
    expect(ok.body.balance).toBe(500);
    await expectOnlySignupMintsMoney();
    await expectBalancesMatchLedger();
  });

  test('余额不足：400，且【什么都没落】——余额不动、无购买记录、无分录', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 5000 }); // 超过注册赠送的 1000

    await request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)).expect(400);

    expect(await pointsOf(bob.userId)).toBe(1000);
    expect(await pointsOf(alice.userId)).toBe(1000);
    const PersonaPurchase = require('../src/models/PersonaPurchase');
    expect(await PersonaPurchase.countDocuments({ user: bob.userId })).toBe(0);
    const PointsLedger = require('../src/models/PointsLedger');
    expect(await PointsLedger.countDocuments({ reason: { $in: ['persona_buy', 'persona_income', 'persona_fee'] } })).toBe(0);
    await expectOnlySignupMintsMoney();
  });

  test('自己的人格无需购买（400）；免费人格无法购买（400）', async () => {
    const alice = await registerUser();
    const paid = await createPersona(alice.token, { price: 100 });
    await request(app).post(`/api/personas/${paid._id}/purchase`).set(authHeader(alice.token)).expect(400);

    const free = await createPersona(alice.token, { name: '免费人格', price: 0 });
    const bob = await registerUser();
    await request(app).post(`/api/personas/${free._id}/purchase`).set(authHeader(bob.token)).expect(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('人格购买 · 选用门（防白嫖）', () => {
  function chatScenarioBody(personaId) {
    return {
      title: '测试聊天情景',
      platform: 'wechat',
      sceneKind: 'chat',
      category: 'workplace',
      shared: false,
      topic: '测试',
      participants: [
        { id: 'p_a', name: '角色A', avatar: '🅰️', role: '上司', isSelf: false, goal: '测试', personaId, personaName: '付费测试人格' },
        { id: 'p_me', name: '我', avatar: '🙂', role: '我', isSelf: true, goal: '' },
      ],
      messages: [{ id: 'm1', senderId: 'p_a', text: '你好' }],
    };
  }

  test('未购买不得把付费人格绑进情景；购买后立即可以', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    // 未购 → 400
    await request(app)
      .post('/api/scenarios')
      .set(authHeader(bob.token))
      .send(chatScenarioBody(persona._id))
      .expect(400);

    // 购买 → 201
    await request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)).expect(200);
    const created = await request(app)
      .post('/api/scenarios')
      .set(authHeader(bob.token))
      .send(chatScenarioBody(persona._id))
      .expect(201);
    const bound = created.body.scenario.participants.find((p) => p.id === 'p_a');
    expect(bound.personaId).toBe(String(persona._id));
  });

  test('存量豁免：免费时合法绑定 → 作者涨价 → 情景仍可编辑；但新增未购付费绑定仍被拒', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    // 免费人格：bob 合法绑定
    const freeThenPaid = await createPersona(alice.token, { name: '先免费后涨价', price: 0 });
    const created = await request(app)
      .post('/api/scenarios')
      .set(authHeader(bob.token))
      .send(chatScenarioBody(freeThenPaid._id))
      .expect(201);
    const scenarioId = created.body.scenario._id;

    // 作者事后涨价
    await request(app)
      .put(`/api/personas/${freeThenPaid._id}`)
      .set(authHeader(alice.token))
      .send({ price: 300 })
      .expect(200);

    // bob 改自己的情景（整包回传 participants，含存量绑定）→ 不得被锁死
    await request(app)
      .put(`/api/scenarios/${scenarioId}`)
      .set(authHeader(bob.token))
      .send({ title: '改个标题', participants: created.body.scenario.participants })
      .expect(200);

    // 但把【另一个】未购的付费人格新增进来，仍要被挡
    const paid = await createPersona(alice.token, { name: '另一个付费人格', price: 200 });
    const withNew = [
      ...created.body.scenario.participants,
      { id: 'p_new', name: '新角色', avatar: '🅱️', role: '同事', isSelf: false, goal: '', personaId: paid._id, personaName: paid.name },
    ];
    await request(app)
      .put(`/api/scenarios/${scenarioId}`)
      .set(authHeader(bob.token))
      .send({ participants: withNew })
      .expect(400);
  });

  test('人格作者自己绑自己的付费人格：不需要购买', async () => {
    const alice = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });
    await request(app)
      .post('/api/scenarios')
      .set(authHeader(alice.token))
      .send(chatScenarioBody(persona._id))
      .expect(201);
  });

  test('装备付费人格：未购 400，购后可装备', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const persona = await createPersona(alice.token, { price: 100 });

    await request(app)
      .post('/api/personas/equip')
      .set(authHeader(bob.token))
      .send({ personaId: persona._id })
      .expect(400);

    await request(app).post(`/api/personas/${persona._id}/purchase`).set(authHeader(bob.token)).expect(200);
    const res = await request(app)
      .post('/api/personas/equip')
      .set(authHeader(bob.token))
      .send({ personaId: persona._id })
      .expect(200);
    expect(res.body.equipped._id).toBe(String(persona._id));
  });
});
