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

// ══ UGC 拉黑端点 /api/blocks（2026-09-03 新增，与私信那套分开）══════════════
// ★★ 为什么另开：/api/messages/blacklist 前面串着三道**私信域**的防滥用闸
//   （对方回复过你才能拉黑…），任何一条不满足就是 403。对 UGC 拉黑那是灾难 ——
//   「我回过他一句、他开始骚扰我」正是最该能拉黑的场景。Play 的 UGC 政策强制要有这个功能，
//   而一个可能 403 的功能等于没有。两套入口、同一张表。
test('UGC 拉黑端点：幂等、回得出人、解除能分辨到底删没删', async () => {
  const alice = await createUser({ username: 'alice_ugc', email: 'alice_ugc@test.local' });
  const bob = await createUser({ username: 'bob_ugc', email: 'bob_ugc@test.local', displayName: 'Bob 显示名' });

  // 列表起手是空的（"问过了，一个都没有"）
  const empty = await request(app).get('/api/blocks').set(authHeader(alice.token));
  expect(empty.status).toBe(200);
  expect(empty.body.items).toEqual([]);

  // 拉黑
  const first = await request(app).post(`/api/blocks/${bob.user._id}`).set(authHeader(alice.token));
  expect(first.status).toBe(200);
  expect(first.body.created).toBe(true);

  // ★ 幂等：再点一次不报错，只是 created=false（UGC 拉黑不该因为"点重了"而失败）
  const again = await request(app).post(`/api/blocks/${bob.user._id}`).set(authHeader(alice.token));
  expect(again.status).toBe(200);
  expect(again.body.created).toBe(false);

  // ★★ 回包必须是**人**，而且 id 是用户 id —— 上一版就栽在这里：回的是拉黑记录，
  //   客户端取到记录 _id 当用户 id，于是"解除"发出去删不掉任何东西（零报错空操作）。
  const list = await request(app).get('/api/blocks').set(authHeader(alice.token));
  expect(list.body.items).toHaveLength(1);
  expect(list.body.items[0].id).toBe(String(bob.user._id));
  expect(list.body.items[0].name).toBe('Bob 显示名');

  // 解除：真删掉了要能看出来
  const removed = await request(app).delete(`/api/blocks/${bob.user._id}`).set(authHeader(alice.token));
  expect(removed.body.removed).toBe(true);
  // ★ 再删一次要回 removed:false —— 只回 {ok:true} 的话，把一个不存在的 id 发过去也是"成功"
  const again2 = await request(app).delete(`/api/blocks/${bob.user._id}`).set(authHeader(alice.token));
  expect(again2.body.removed).toBe(false);

  const after = await request(app).get('/api/blocks').set(authHeader(alice.token));
  expect(after.body.items).toEqual([]);
});

test('UGC 拉黑：不能拉黑自己，非法 id 与不存在的人一律 400', async () => {
  const alice = await createUser({ username: 'alice_ugc2', email: 'alice_ugc2@test.local' });
  const self = await request(app).post(`/api/blocks/${alice.user._id}`).set(authHeader(alice.token));
  expect(self.status).toBe(400);
  const bad = await request(app).post('/api/blocks/not-an-id').set(authHeader(alice.token));
  expect(bad.status).toBe(400);
  const ghost = await request(app)
    .post(`/api/blocks/${new mongoose.Types.ObjectId()}`)
    .set(authHeader(alice.token));
  expect(ghost.status).toBe(400);
});

test('拉黑之后：详情页内联的那 50 条评论、以及收藏列表，都不再出现对方', async () => {
  const BranchVideo = require('../src/models/BranchVideo');
  const BranchComment = require('../src/models/BranchComment');
  const BranchCollect = require('../src/models/BranchCollect');

  const alice = await createUser({ username: 'alice_d', email: 'alice_d@test.local' });
  const bob = await createUser({ username: 'bob_d', email: 'bob_d@test.local' });
  const carol = await createUser({ username: 'carol_d', email: 'carol_d@test.local' });

  const carolVideo = await BranchVideo.create({ title: 'Carol 作品', author: carol.user._id, visibility: 'public', segments: [] });
  const bobVideo = await BranchVideo.create({ title: 'Bob 作品', author: bob.user._id, visibility: 'public', segments: [] });
  await BranchComment.create({ video: carolVideo._id, author: bob.user._id, text: 'bob 的评论' });
  await BranchComment.create({ video: carolVideo._id, author: carol.user._id, text: 'carol 的评论' });
  // alice 收藏了两条
  await BranchCollect.create({ user: alice.user._id, video: bobVideo._id });
  await BranchCollect.create({ user: alice.user._id, video: carolVideo._id });

  await request(app).post(`/api/blocks/${bob.user._id}`).set(authHeader(alice.token));

  // ★★ 详情页那 50 条内联评论**才是产品里评论的真实来源**（App 侧 listComments 零调用方）
  const detail = await request(app)
    .get(`/api/branch/videos/${carolVideo._id}`)
    .set(authHeader(alice.token));
  const texts = (detail.body.video?.comments ?? detail.body.comments ?? []).map((c) => c.text);
  expect(texts).not.toContain('bob 的评论');
  expect(texts).toContain('carol 的评论');

  // ★ 收藏页是产品内用户自己点得到的一条路
  const collects = await request(app).get('/api/branch/me/collects').set(authHeader(alice.token));
  expect(collects.body.ids).not.toContain(String(bobVideo._id));
  expect(collects.body.ids).toContain(String(carolVideo._id));
});
