const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  // require after setting MONGO_URI
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

/** 注册一个用户并返回其 token（创建榜单现在需要登录） */
async function registerUser(username) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, email: `${username}@example.com`, password: 'pw123456' })
    .expect(201);
  return res.body.token;
}

test('create leaderboard and query paginated results', async () => {
  const Idea = require('../src/models/Idea');
  const TagVote = require('../src/models/TagVote');

  // create sample ideas
  const a = await Idea.create({ title: 'One', summary: '', content: '', author: new mongoose.Types.ObjectId(), tags: ['alpha','beta'], visibility: 'public' });
  const b = await Idea.create({ title: 'Two', summary: '', content: '', author: new mongoose.Types.ObjectId(), tags: ['alpha'], visibility: 'public' });

  // votes
  await TagVote.create({ idea: a._id, tags: ['alpha','beta'], tagsKey: 'alpha|beta', user: new mongoose.Types.ObjectId(), vote: 1 });
  await TagVote.create({ idea: b._id, tags: ['alpha'], tagsKey: 'alpha', user: new mongoose.Types.ObjectId(), vote: 1 });

  // create leaderboard for alpha|beta —— 需要登录（匿名可写会让任何人覆盖他人榜单）
  const token = await registerUser('boarder');
  const createRes = await request(app)
    .post('/api/tag-rank/leaderboard')
    .set('Authorization', `Bearer ${token}`)
    .send({ tags: 'alpha,beta' })
    .expect(200);
  expect(createRes.body.ok).toBe(true);
  // query leaderboard
  const res = await request(app).get('/api/tag-rank?tags=alpha,beta&page=1&limit=10').expect(200);
  expect(res.body.ok).toBe(true);
  expect(Array.isArray(res.body.results)).toBe(true);
  expect(res.body.results.length).toBeGreaterThanOrEqual(0);
});

test('匿名不能创建/覆盖榜单', async () => {
  // 回归用例：这个端点曾经挂的是 optionalAuth，而 createLeaderboard 是带 upsert 的
  // findOneAndUpdate —— 匿名请求即可用同一 tagsKey 把他人榜单的 entries 整个覆盖掉。
  await request(app)
    .post('/api/tag-rank/leaderboard')
    .send({ tags: 'alpha,beta' })
    .expect(401);
});
