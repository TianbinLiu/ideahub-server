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
    username: attrs.username || `msg_${random}`,
    email: attrs.email || `${random}@test.local`,
    role: attrs.role || 'user',
    passwordHash: 'hashed',
    displayName: attrs.displayName || '',
    bio: attrs.bio || '',
  });

  return { user, token: signToken(user) };
}

function conversationId(userA, userB) {
  return [String(userA), String(userB)].sort().join(':');
}

async function makeMutualFollow(userAId, userBId) {
  const Follow = require('../src/models/Follow');
  await Promise.all([
    Follow.updateOne(
      { follower: userAId, following: userBId },
      { $setOnInsert: { follower: userAId, following: userBId } },
      { upsert: true }
    ),
    Follow.updateOne(
      { follower: userBId, following: userAId },
      { $setOnInsert: { follower: userBId, following: userAId } },
      { upsert: true }
    ),
  ]);
}

test('mutual followers can send a direct message without a pending request', async () => {
  const MessageRequest = require('../src/models/MessageRequest');

  const alice = await createUser({ username: 'mutual_alice', email: 'mutual_alice@test.local' });
  const bob = await createUser({ username: 'mutual_bob', email: 'mutual_bob@test.local' });

  await makeMutualFollow(alice.user._id, bob.user._id);

  const sendRes = await request(app)
    .post('/api/messages/request')
    .set(authHeader(alice.token))
    .send({ toUserId: bob.user._id, initialMessage: 'hello mutual' })
    .expect(200);

  expect(sendRes.body.direct).toBe(true);
  expect(sendRes.body.conversationId).toBe(conversationId(alice.user._id, bob.user._id));
  expect(await MessageRequest.countDocuments()).toBe(0);

  const bobConversations = await request(app)
    .get('/api/messages/conversations')
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobConversations.body.conversations).toHaveLength(1);
  expect(bobConversations.body.conversations[0].lastMessage.content).toBe('hello mutual');
  expect(bobConversations.body.conversations[0].otherUser.username).toBe('mutual_alice');

  const bobUnread = await request(app)
    .get('/api/notifications/unread-count')
    .set(authHeader(bob.token))
    .expect(200);
  expect(bobUnread.body.count).toBe(1);

  await request(app)
    .get(`/api/messages/conversations/${encodeURIComponent(sendRes.body.conversationId)}`)
    .set(authHeader(bob.token))
    .expect(200);

  const bobUnreadAfterRead = await request(app)
    .get('/api/notifications/unread-count')
    .set(authHeader(bob.token))
    .expect(200);
  expect(bobUnreadAfterRead.body.count).toBe(0);
});

test('stranger message request can be rejected with a reply and cannot be followed by instant blacklist abuse', async () => {
  const DmRequestBlock = require('../src/models/DmRequestBlock');

  const alice = await createUser({ username: 'req_alice', email: 'req_alice@test.local' });
  const bob = await createUser({ username: 'req_bob', email: 'req_bob@test.local' });

  const reqRes = await request(app)
    .post('/api/messages/request')
    .set(authHeader(alice.token))
    .send({ toUserId: bob.user._id, initialMessage: 'please chat' })
    .expect(200);

  expect(reqRes.body.request.status).toBe('pending');

  const blockBeforeResponse = await request(app)
    .post(`/api/messages/blacklist/${bob.user._id}`)
    .set(authHeader(alice.token));

  expect(blockBeforeResponse.status).toBe(403);
  expect(blockBeforeResponse.body.message).toMatch(/respond/i);

  await request(app)
    .patch(`/api/messages/request/${reqRes.body.request._id}/reject`)
    .set(authHeader(bob.token))
    .send({ responseMessage: 'No thanks.' })
    .expect(200);

  const sentRequests = await request(app)
    .get('/api/messages/request')
    .set(authHeader(alice.token))
    .expect(200);

  expect(sentRequests.body.sentRequests[0].status).toBe('rejected');
  expect(sentRequests.body.sentRequests[0].responseMessage).toBe('No thanks.');

  await request(app)
    .post(`/api/messages/blacklist/${bob.user._id}`)
    .set(authHeader(alice.token))
    .expect(200);

  expect(await DmRequestBlock.countDocuments({ blockerUserId: alice.user._id, blockedUserId: bob.user._id })).toBe(1);
});

test('request receiver replying directly accepts the request and includes the initial message', async () => {
  const MessageRequest = require('../src/models/MessageRequest');

  const alice = await createUser({ username: 'reply_alice', email: 'reply_alice@test.local' });
  const bob = await createUser({ username: 'reply_bob', email: 'reply_bob@test.local' });
  const convId = conversationId(alice.user._id, bob.user._id);

  await request(app)
    .post('/api/messages/request')
    .set(authHeader(alice.token))
    .send({ toUserId: bob.user._id, initialMessage: 'initial hidden request' })
    .expect(200);

  await request(app)
    .post('/api/messages/send')
    .set(authHeader(bob.token))
    .send({ conversationId: convId, toUserId: alice.user._id, content: 'reply accepts' })
    .expect(200);

  const storedRequest = await MessageRequest.findOne({ fromUserId: alice.user._id, toUserId: bob.user._id }).lean();
  expect(storedRequest.status).toBe('accepted');

  const messages = await request(app)
    .get(`/api/messages/conversations/${encodeURIComponent(convId)}`)
    .set(authHeader(alice.token))
    .expect(200);

  expect(messages.body.messages.map((msg) => msg.content)).toEqual(['initial hidden request', 'reply accepts']);
});

test('deleting a conversation hides it only for the requesting user', async () => {
  const alice = await createUser({ username: 'delete_alice', email: 'delete_alice@test.local' });
  const bob = await createUser({ username: 'delete_bob', email: 'delete_bob@test.local' });
  const convId = conversationId(alice.user._id, bob.user._id);

  await makeMutualFollow(alice.user._id, bob.user._id);

  await request(app)
    .post('/api/messages/request')
    .set(authHeader(alice.token))
    .send({ toUserId: bob.user._id, initialMessage: 'delete visibility' })
    .expect(200);

  await request(app)
    .delete(`/api/messages/conversations/${encodeURIComponent(convId)}`)
    .set(authHeader(alice.token))
    .expect(200);

  const aliceConversations = await request(app)
    .get('/api/messages/conversations')
    .set(authHeader(alice.token))
    .expect(200);
  expect(aliceConversations.body.conversations).toHaveLength(0);

  const bobConversations = await request(app)
    .get('/api/messages/conversations')
    .set(authHeader(bob.token))
    .expect(200);
  expect(bobConversations.body.conversations).toHaveLength(1);
  expect(bobConversations.body.conversations[0].lastMessage.content).toBe('delete visibility');
});