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
    username: attrs.username || `user_${random}`,
    email: attrs.email || `${random}@test.local`,
    role: attrs.role || 'user',
    passwordHash: 'hashed',
    displayName: attrs.displayName || '',
    bio: attrs.bio || '',
  });

  return { user, token: signToken(user) };
}

test('blocking requires a reply back if the blocker replied first', async () => {
  const Idea = require('../src/models/Idea');
  const Comment = require('../src/models/Comment');

  const alice = await createUser({ username: 'alice', email: 'alice@test.local' });
  const bob = await createUser({ username: 'bob', email: 'bob@test.local' });

  const idea = await Idea.create({
    title: 'Block rule idea',
    summary: '',
    content: '',
    author: bob.user._id,
    tags: ['block'],
    visibility: 'public',
  });

  const bobComment = await Comment.create({
    idea: idea._id,
    author: bob.user._id,
    content: 'root from bob',
  });

  await Comment.create({
    idea: idea._id,
    author: alice.user._id,
    content: 'reply from alice',
    parentCommentId: bobComment._id,
  });

  const blockedBeforeReplyBack = await request(app)
    .post(`/api/messages/blacklist/${bob.user._id}`)
    .set(authHeader(alice.token));

  expect(blockedBeforeReplyBack.status).toBe(403);
  expect(blockedBeforeReplyBack.body.message).toContain('replied to you at least once');

  const aliceComment = await Comment.create({
    idea: idea._id,
    author: alice.user._id,
    content: 'root from alice',
  });

  await Comment.create({
    idea: idea._id,
    author: bob.user._id,
    content: 'reply from bob',
    parentCommentId: aliceComment._id,
  });

  const blockedAfterReplyBack = await request(app)
    .post(`/api/messages/blacklist/${bob.user._id}`)
    .set(authHeader(alice.token));

  expect(blockedAfterReplyBack.status).toBe(200);
  expect(blockedAfterReplyBack.body.ok).toBe(true);
});

test('a single block hides profile, ideas, and comments from both sides', async () => {
  const Idea = require('../src/models/Idea');
  const Comment = require('../src/models/Comment');
  const DmRequestBlock = require('../src/models/DmRequestBlock');

  const alice = await createUser({ username: 'alice2', email: 'alice2@test.local' });
  const bob = await createUser({ username: 'bob2', email: 'bob2@test.local' });
  const carol = await createUser({ username: 'carol2', email: 'carol2@test.local' });

  const aliceIdea = await Idea.create({
    title: 'Alice public idea',
    summary: '',
    content: '',
    author: alice.user._id,
    tags: ['alpha'],
    visibility: 'public',
  });

  await Idea.create({
    title: 'Carol public idea',
    summary: '',
    content: '',
    author: carol.user._id,
    tags: ['beta'],
    visibility: 'public',
  });

  await Comment.create({
    idea: aliceIdea._id,
    author: alice.user._id,
    content: 'alice root comment',
  });

  await DmRequestBlock.create({ blockerUserId: alice.user._id, blockedUserId: bob.user._id });

  const profileRes = await request(app)
    .get(`/api/users/${alice.user._id}`)
    .set(authHeader(bob.token));

  expect(profileRes.status).toBe(404);

  const listIdeasRes = await request(app)
    .get('/api/ideas')
    .set(authHeader(bob.token))
    .expect(200);

  const returnedIdeaIds = (listIdeasRes.body.ideas || []).map((idea) => String(idea._id));
  expect(returnedIdeaIds).not.toContain(String(aliceIdea._id));

  const commentsRes = await request(app)
    .get(`/api/ideas/${aliceIdea._id}/comments`)
    .set(authHeader(bob.token));

  expect(commentsRes.status).toBe(404);

  const reverseProfileRes = await request(app)
    .get(`/api/users/${bob.user._id}`)
    .set(authHeader(alice.token));

  expect(reverseProfileRes.status).toBe(404);
});

// ══ 分支视频这一侧（2026-09-03 补）══════════════════════════════════════════
// ★★ 为什么补在**这一份** spec 里而不是新开一个：拉黑是一条规则，它的覆盖不该散在两处
//   —— 上面那几条测的是"点子"那条线，下面这条测的是分支视频。哪天判据改了，
//   一份文件就能看出还有谁没跟着改。
// ★ 这是上架 Google Play 的**硬要求**（UGC 政策强制"拉黑用户"），不是锦上添花：
//   服务端本来有拉黑关系（DmRequestBlock）、有通知闸、有搜索过滤，唯独分支视频这一侧
//   的三条读接口（feed / 评论 / 弹幕）一个字都没判 —— 拉黑之后照样满屏都是他。
test('拉黑之后：feed、评论、弹幕三条读接口都不再出现对方的内容（双向）', async () => {
  const BranchVideo = require('../src/models/BranchVideo');
  const BranchComment = require('../src/models/BranchComment');
  const BranchDanmaku = require('../src/models/BranchDanmaku');
  const DmRequestBlock = require('../src/models/DmRequestBlock');

  const alice = await createUser({ username: 'alice_b', email: 'alice_b@test.local' });
  const bob = await createUser({ username: 'bob_b', email: 'bob_b@test.local' });
  const carol = await createUser({ username: 'carol_b', email: 'carol_b@test.local' });

  const mk = (author, title) =>
    BranchVideo.create({ title, author: author.user._id, visibility: 'public', segments: [] });

  const bobVideo = await mk(bob, 'Bob 的作品');
  const carolVideo = await mk(carol, 'Carol 的作品');

  // 在 carol 的作品下：bob 与 carol 各一条评论 + 各一条弹幕
  await BranchComment.create({ video: carolVideo._id, author: bob.user._id, text: 'bob 的评论' });
  await BranchComment.create({ video: carolVideo._id, author: carol.user._id, text: 'carol 的评论' });
  await BranchDanmaku.create({ video: carolVideo._id, author: bob.user._id, at: 1, text: 'bob 弹幕' });
  await BranchDanmaku.create({ video: carolVideo._id, author: carol.user._id, at: 2, text: 'carol 弹幕' });

  // 拉黑之前：三条接口都看得到 bob
  const before = await request(app).get('/api/branch/videos').set(authHeader(alice.token));
  expect(before.status).toBe(200);
  expect(before.body.items.map((v) => v.title)).toEqual(expect.arrayContaining(['Bob 的作品', 'Carol 的作品']));

  // alice 拉黑 bob（走产品里真实的那个端点，不是直接写库 —— 端点变了这条测试要跟着红）
  const blocked = await request(app)
    .post(`/api/messages/blacklist/${bob.user._id}`)
    .set(authHeader(alice.token));
  expect([200, 201]).toContain(blocked.status);
  expect(await DmRequestBlock.countDocuments({ blockerUserId: alice.user._id })).toBe(1);

  // ① feed：bob 的作品不见了，carol 的还在
  const feed = await request(app).get('/api/branch/videos').set(authHeader(alice.token));
  const titles = feed.body.items.map((v) => v.title);
  expect(titles).not.toContain('Bob 的作品');
  expect(titles).toContain('Carol 的作品');

  // ② 评论：bob 那条不见了，carol 那条还在
  const comments = await request(app)
    .get(`/api/branch/videos/${carolVideo._id}/comments`)
    .set(authHeader(alice.token));
  const texts = comments.body.items.map((c) => c.text);
  expect(texts).not.toContain('bob 的评论');
  expect(texts).toContain('carol 的评论');

  // ③ 弹幕：同上
  const danmaku = await request(app)
    .get(`/api/branch/videos/${carolVideo._id}/danmaku`)
    .set(authHeader(alice.token));
  const dm = danmaku.body.items.map((d) => d.text);
  expect(dm).not.toContain('bob 弹幕');
  expect(dm).toContain('carol 弹幕');

  // ④ **双向**：被拉黑的一方也看不见拉黑者的内容（与通知那条闸同一口径）
  const aliceVideo = await mk(alice, 'Alice 的作品');
  expect(aliceVideo._id).toBeTruthy();
  const bobFeed = await request(app).get('/api/branch/videos').set(authHeader(bob.token));
  expect(bobFeed.body.items.map((v) => v.title)).not.toContain('Alice 的作品');

  // ⑤ **没登录不过滤**：optionalAuth 下不该多打一次库，也不该凭空隐藏内容
  const anon = await request(app).get('/api/branch/videos');
  expect(anon.body.items.map((v) => v.title)).toEqual(expect.arrayContaining(['Bob 的作品', 'Carol 的作品']));
});
