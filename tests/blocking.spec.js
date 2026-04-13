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