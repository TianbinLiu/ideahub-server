// tests/accountDeactivate.spec.js
// 覆盖：账号注销（软删除）+ 发言风格档案删除
//   POST   /api/me/deactivate
//   DELETE /api/speaking-style
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
    username: attrs.username || `deact_${random}`,
    email: attrs.email || `${random}@test.local`,
    role: attrs.role || 'user',
    passwordHash: 'hashed',
  });

  return { user, token: signToken(user) };
}

describe('POST /api/me/deactivate', () => {
  test('注销后旧 token 立即 401（Account deactivated）', async () => {
    const { user, token } = await createUser();

    // 注销前：旧 token 可用
    await request(app).get('/api/speaking-style').set(authHeader(token)).expect(200);

    const res = await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: user.username })
      .expect(200);
    expect(res.body.ok).toBe(true);

    // 注销后：同一个旧 token 立刻失效
    const after = await request(app)
      .get('/api/speaking-style')
      .set(authHeader(token))
      .expect(401);
    expect(after.body.ok).toBe(false);
    expect(after.body.message).toBe('Account deactivated');

    // deactivatedAt 已打标记 + tokenVersion 已自增（旧 token 全部作废）
    const User = require('../src/models/User');
    const fresh = await User.findById(user._id).select('deactivatedAt tokenVersion').lean();
    expect(fresh.deactivatedAt).toBeInstanceOf(Date);
    expect(fresh.tokenVersion).toBe(Number(user.tokenVersion || 0) + 1);
  });

  test('signToken 拒绝为已注销账号签发 token', async () => {
    // 注销后不能只是「旧 token 失效」，还必须【签不出新 token】——
    // 否则用户能登录成功拿到 token，然后每个接口都 401，陷入登录→被踹的死循环，
    // 而界面还写着「账号将无法登录」＝对用户撒谎。
    const { user, token } = await createUser();
    await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: user.username })
      .expect(200);

    const User = require('../src/models/User');
    const { signToken } = require('../src/utils/jwt');
    const fresh = await User.findById(user._id);
    expect(() => signToken(fresh)).toThrow('Account deactivated');
  });

  test('即使伪造一个 tokenVersion 匹配的 token，已注销账号仍 401', async () => {
    // 证明拦截真正来自 deactivatedAt，而不是只靠 tokenVersion 自增；
    // 否则 deactivatedAt 就是死代码，「注销」只是换了一次 token。
    //
    // ★这里【绕过 signToken 直接用 jwt.sign】：signToken 现在会拒绝为已注销账号签名
    // （见上一条用例），所以拿不到这种 token。而本用例要模拟的正是
    // 「攻击者/陈旧客户端手里有一个 tokenVersion 恰好对得上的 token」——
    // 那种 token 现实中不经过 signToken，测试也不该经过。
    const jwt = require('jsonwebtoken');
    const { user, token } = await createUser();
    await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: user.username })
      .expect(200);

    const User = require('../src/models/User');
    const fresh = await User.findById(user._id);
    const forged = jwt.sign(
      { sub: String(fresh._id), role: fresh.role, tokenVersion: Number(fresh.tokenVersion || 0) },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    ); // tokenVersion 与库里完全一致 → 只可能被 deactivatedAt 拦下

    const res = await request(app)
      .get('/api/speaking-style')
      .set(authHeader(forged))
      .expect(401);
    expect(res.body.message).toBe('Account deactivated');
  });

  test('confirmUsername 不匹配 → 400，且账号未被注销', async () => {
    const { user, token } = await createUser();

    const res = await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: `${user.username}-wrong` })
      .expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toBe('用户名不匹配');

    // 没有误伤：账号仍然可用
    const User = require('../src/models/User');
    const fresh = await User.findById(user._id).select('deactivatedAt tokenVersion').lean();
    expect(fresh.deactivatedAt).toBe(null);
    expect(fresh.tokenVersion).toBe(Number(user.tokenVersion || 0));
    await request(app).get('/api/speaking-style').set(authHeader(token)).expect(200);
  });

  test('confirmUsername 必须严格全等：大小写/空格差异一律 400', async () => {
    const { user, token } = await createUser({ username: 'ExactCase' });

    for (const wrong of ['exactcase', ' ExactCase', 'ExactCase ']) {
      const res = await request(app)
        .post('/api/me/deactivate')
        .set(authHeader(token))
        .send({ confirmUsername: wrong })
        .expect(400);
      expect(res.body.message).toBe('用户名不匹配');
    }

    const User = require('../src/models/User');
    const fresh = await User.findById(user._id).select('deactivatedAt').lean();
    expect(fresh.deactivatedAt).toBe(null);
  });

  test('缺 confirmUsername → 400（zod 校验）', async () => {
    const { token } = await createUser();
    await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({})
      .expect(400);
  });

  test('未登录 → 401', async () => {
    await request(app).post('/api/me/deactivate').send({ confirmUsername: 'x' }).expect(401);
  });

  test('注销不删任何内容数据（软删除、可恢复）', async () => {
    const Idea = require('../src/models/Idea');
    const Comment = require('../src/models/Comment');
    const SpeakingProfile = require('../src/models/SpeakingProfile');
    const StyleSample = require('../src/models/StyleSample');
    const User = require('../src/models/User');

    const { user, token } = await createUser();

    const idea = await Idea.create({
      title: 'Keep me',
      summary: '',
      content: 'content',
      author: user._id,
      tags: ['alpha'],
      visibility: 'public',
    });
    const comment = await Comment.create({ idea: idea._id, author: user._id, content: 'hello' });
    await SpeakingProfile.create({ user: user._id, summary: 'sum', sampleCount: 1 });
    await StyleSample.create({ user: user._id, text: 'sample text', hash: 'hash-keep-1' });

    await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: user.username })
      .expect(200);

    // 内容数据一条都不能少
    expect(await Idea.countDocuments({ author: user._id })).toBe(1);
    expect(await Comment.countDocuments({ author: user._id })).toBe(1);
    expect(await SpeakingProfile.countDocuments({ user: user._id })).toBe(1);
    expect(await StyleSample.countDocuments({ user: user._id })).toBe(1);
    expect(await Idea.findById(idea._id)).not.toBeNull();
    expect(await Comment.findById(comment._id)).not.toBeNull();

    // User 本身也保留（只是打了标记），所以可恢复
    const fresh = await User.findById(user._id);
    expect(fresh).not.toBeNull();
    expect(fresh.username).toBe(user.username);

    // 可恢复性验证：清掉标记 + 重签 token → 账号立刻恢复正常
    await User.updateOne({ _id: user._id }, { $set: { deactivatedAt: null } });
    const { signToken } = require('../src/utils/jwt');
    const restored = signToken(await User.findById(user._id));
    const res = await request(app).get('/api/speaking-style').set(authHeader(restored)).expect(200);
    expect(res.body.profile.summary).toBe('sum');
  });

  test('已注销账号在 optionalAuth 路由上当匿名，不报错', async () => {
    const { user, token } = await createUser();
    const SpeakingProfile = require('../src/models/SpeakingProfile');
    await SpeakingProfile.create({ user: user._id, summary: 'public sum', sampleCount: 1 });

    await request(app)
      .post('/api/me/deactivate')
      .set(authHeader(token))
      .send({ confirmUsername: user.username })
      .expect(200);

    // GET /user/:userId 走 optionalAuth：坏掉的登录态不应阻塞公开读取
    const res = await request(app)
      .get(`/api/speaking-style/user/${user._id}`)
      .set(authHeader(token))
      .expect(200);
    expect(res.body.ok).toBe(true);
    // 当匿名 → 不返回本人行为数据 styleTally
    expect(res.body.profile.styleTally).toBeUndefined();
  });
});

describe('DELETE /api/speaking-style', () => {
  test('删档案后 GET 返回 profile:null', async () => {
    const SpeakingProfile = require('../src/models/SpeakingProfile');
    const { user, token } = await createUser();
    await SpeakingProfile.create({ user: user._id, summary: 'sum', sampleCount: 3 });

    const before = await request(app).get('/api/speaking-style').set(authHeader(token)).expect(200);
    expect(before.body.profile).not.toBeNull();

    const del = await request(app).delete('/api/speaking-style').set(authHeader(token)).expect(200);
    expect(del.body).toEqual({ ok: true, deleted: true });

    const after = await request(app).get('/api/speaking-style').set(authHeader(token)).expect(200);
    expect(after.body.ok).toBe(true);
    expect(after.body.profile).toBeNull();

    expect(await SpeakingProfile.countDocuments({ user: user._id })).toBe(0);
  });

  test('没有档案时 deleted:false（幂等，不报错）', async () => {
    const { token } = await createUser();
    const res = await request(app).delete('/api/speaking-style').set(authHeader(token)).expect(200);
    expect(res.body).toEqual({ ok: true, deleted: false });
  });

  test('只删自己的档案，不碰别人的', async () => {
    const SpeakingProfile = require('../src/models/SpeakingProfile');
    const a = await createUser();
    const b = await createUser();
    await SpeakingProfile.create({ user: a.user._id, summary: 'a-sum' });
    await SpeakingProfile.create({ user: b.user._id, summary: 'b-sum' });

    await request(app).delete('/api/speaking-style').set(authHeader(a.token)).expect(200);

    expect(await SpeakingProfile.countDocuments({ user: a.user._id })).toBe(0);
    expect(await SpeakingProfile.countDocuments({ user: b.user._id })).toBe(1);
  });

  test('DELETE / 不影响 DELETE /samples（同前缀不同路由）', async () => {
    const SpeakingProfile = require('../src/models/SpeakingProfile');
    const StyleSample = require('../src/models/StyleSample');
    const { user, token } = await createUser();
    await SpeakingProfile.create({ user: user._id, summary: 'sum' });
    await StyleSample.create({ user: user._id, text: 'keep me', hash: 'hash-sep-1' });

    // 删档案不应连带删掉样本
    await request(app).delete('/api/speaking-style').set(authHeader(token)).expect(200);
    expect(await StyleSample.countDocuments({ user: user._id })).toBe(1);

    // 清样本仍然走自己的路由
    const res = await request(app).delete('/api/speaking-style/samples').set(authHeader(token)).expect(200);
    expect(res.body).toEqual({ ok: true, deleted: 1 });
  });

  test('未登录 → 401', async () => {
    await request(app).delete('/api/speaking-style').expect(401);
  });
});
