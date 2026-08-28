// tests/acceptTerms.spec.js
// 覆盖：用户协议同意留痕
//   POST /api/me/accept-terms（写：版本 + 时间戳，幂等）
//   GET  /api/auth/me       （读：termsAcceptedVersion 随 serializeAuthUser 返回）
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
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createUser(attrs = {}) {
  const User = require('../src/models/User');
  const { signToken } = require('../src/utils/jwt');

  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({
    username: attrs.username || `terms_${random}`,
    email: attrs.email || `${random}@test.local`,
    role: attrs.role || 'user',
    passwordHash: 'hashed',
  });

  return { user, token: signToken(user) };
}

describe('POST /api/me/accept-terms', () => {
  test('写入版本与时间戳，/api/auth/me 能读回来', async () => {
    const { user, token } = await createUser();

    // 存量用户：没同意过 = 空串（判否定那条约定的另一半）
    const before = await request(app).get('/api/auth/me').set(authHeader(token)).expect(200);
    expect(before.body.user.termsAcceptedVersion).toBe('');

    const res = await request(app)
      .post('/api/me/accept-terms')
      .set(authHeader(token))
      .send({ version: '2026-08-28' })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, termsAcceptedVersion: '2026-08-28' });

    const User = require('../src/models/User');
    const doc = await User.findById(user._id).lean();
    expect(doc.termsAcceptedVersion).toBe('2026-08-28');
    expect(doc.termsAcceptedAt).toBeInstanceOf(Date);

    const after = await request(app).get('/api/auth/me').set(authHeader(token)).expect(200);
    expect(after.body.user.termsAcceptedVersion).toBe('2026-08-28');
  });

  test('幂等：重复提交同版本只刷新时间戳，不报错', async () => {
    const { user, token } = await createUser();
    await request(app).post('/api/me/accept-terms').set(authHeader(token)).send({ version: 'v1' }).expect(200);
    const User = require('../src/models/User');
    const first = (await User.findById(user._id).lean()).termsAcceptedAt;

    await new Promise((r) => setTimeout(r, 5));
    await request(app).post('/api/me/accept-terms').set(authHeader(token)).send({ version: 'v1' }).expect(200);
    const second = (await User.findById(user._id).lean()).termsAcceptedAt;
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  test('缺 version / 超长 version 被 400 挡下', async () => {
    const { token } = await createUser();
    await request(app).post('/api/me/accept-terms').set(authHeader(token)).send({}).expect(400);
    await request(app)
      .post('/api/me/accept-terms')
      .set(authHeader(token))
      .send({ version: 'x'.repeat(33) })
      .expect(400);
  });

  test('未登录 401', async () => {
    await request(app).post('/api/me/accept-terms').send({ version: 'v1' }).expect(401);
  });
});
