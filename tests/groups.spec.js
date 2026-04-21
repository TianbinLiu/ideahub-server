const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.FREE_PUBLIC_IDEA_LIMIT = '50';

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
    joinedGroupSlugs: attrs.joinedGroupSlugs || [],
  });

  return { user, token: signToken(user) };
}

function createIdea(token, body = {}) {
  return request(app)
    .post('/api/ideas')
    .set(authHeader(token))
    .send({
      title: body.title || 'Test idea',
      summary: body.summary || 'summary',
      content: body.content || 'content',
      tags: body.tags || ['alpha'],
      visibility: body.visibility || 'public',
      ideaType: body.ideaType || 'daily',
      groupSlug: body.groupSlug || 'world',
      ...body,
    });
}

test('group lifecycle endpoints expose world, create join leave, and keep member counts stable', async () => {
  const Group = require('../src/models/Group');
  const User = require('../src/models/User');

  const alice = await createUser({ username: 'group_alice', email: 'group_alice@test.local' });
  const bob = await createUser({ username: 'group_bob', email: 'group_bob@test.local' });

  const publicList = await request(app).get('/api/groups').expect(200);
  expect(publicList.body.groups[0].slug).toBe('world');
  expect(publicList.body.groups[0].isWorld).toBe(true);

  const createRes = await request(app)
    .post('/api/groups')
    .set(authHeader(alice.token))
    .send({ name: 'Design Circle', description: 'share design ideas' })
    .expect(201);

  expect(createRes.body.group.slug).toBe('design-circle');
  expect(createRes.body.group.joined).toBe(true);

  const persistedCreator = await User.findById(alice.user._id).lean();
  expect(persistedCreator.joinedGroupSlugs).toContain('design-circle');

  const bobJoin = await request(app)
    .post('/api/groups/design-circle/join')
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobJoin.body.joined).toBe(true);

  const afterJoin = await Group.findOne({ slug: 'design-circle' }).lean();
  expect(afterJoin.memberCount).toBe(2);

  await request(app)
    .post('/api/groups/design-circle/join')
    .set(authHeader(bob.token))
    .expect(200);

  const afterDuplicateJoin = await Group.findOne({ slug: 'design-circle' }).lean();
  expect(afterDuplicateJoin.memberCount).toBe(2);

  const bobLeave = await request(app)
    .post('/api/groups/design-circle/leave')
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobLeave.body.joined).toBe(false);

  const afterLeave = await Group.findOne({ slug: 'design-circle' }).lean();
  expect(afterLeave.memberCount).toBe(1);

  await request(app)
    .post('/api/groups/design-circle/leave')
    .set(authHeader(bob.token))
    .expect(200);

  const afterDuplicateLeave = await Group.findOne({ slug: 'design-circle' }).lean();
  expect(afterDuplicateLeave.memberCount).toBe(1);

  const persistedBob = await User.findById(bob.user._id).lean();
  expect(persistedBob.joinedGroupSlugs || []).not.toContain('design-circle');

  await request(app)
    .post('/api/groups/world/join')
    .set(authHeader(bob.token))
    .expect(200);

  const afterWorldJoin = await User.findById(bob.user._id).lean();
  expect(afterWorldJoin.joinedGroupSlugs || []).not.toContain('world');

  await request(app)
    .post('/api/groups/world/leave')
    .set(authHeader(alice.token))
    .expect(400);

  const aliceList = await request(app)
    .get('/api/groups')
    .set(authHeader(alice.token))
    .expect(200);

  const designCircle = aliceList.body.groups.find((group) => group.slug === 'design-circle');
  expect(designCircle.joined).toBe(true);
});

test('group membership gates posting, listing, and reading group-scoped ideas', async () => {
  const Group = require('../src/models/Group');

  const alice = await createUser({ username: 'idea_alice', email: 'idea_alice@test.local' });
  const bob = await createUser({ username: 'idea_bob', email: 'idea_bob@test.local' });

  await Group.create({
    name: 'Secret Lab',
    slug: 'secret-lab',
    description: 'private experiments',
    creator: alice.user._id,
    memberCount: 1,
  });

  const deniedPost = await createIdea(bob.token, {
    title: 'Bob cannot post here',
    groupSlug: 'secret-lab',
  }).expect(403);

  expect(deniedPost.body.code).toBe('GROUP_ACCESS_DENIED');

  await request(app)
    .post('/api/groups/secret-lab/join')
    .set(authHeader(alice.token))
    .expect(200);

  const aliceIdeaRes = await createIdea(alice.token, {
    title: 'Secret idea',
    groupSlug: 'secret-lab',
    ideaType: 'daily',
  }).expect(201);

  const secretIdeaId = aliceIdeaRes.body.idea._id;

  const anonList = await request(app)
    .get('/api/ideas?group=secret-lab')
    .expect(200);

  expect(anonList.body.ideas).toEqual([]);

  const bobListBeforeJoin = await request(app)
    .get('/api/ideas?group=secret-lab')
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobListBeforeJoin.body.ideas).toEqual([]);

  const bobDetailBeforeJoin = await request(app)
    .get(`/api/ideas/${secretIdeaId}`)
    .set(authHeader(bob.token));

  expect([403, 404]).toContain(bobDetailBeforeJoin.status);

  const anonDetailBeforeJoin = await request(app)
    .get(`/api/ideas/${secretIdeaId}`);

  expect([401, 403, 404]).toContain(anonDetailBeforeJoin.status);

  await request(app)
    .post('/api/groups/secret-lab/join')
    .set(authHeader(bob.token))
    .expect(200);

  const bobListAfterJoin = await request(app)
    .get('/api/ideas?group=secret-lab')
    .set(authHeader(bob.token))
    .expect(200);

  expect((bobListAfterJoin.body.ideas || []).map((idea) => idea._id)).toContain(secretIdeaId);

  const bobDetailAfterJoin = await request(app)
    .get(`/api/ideas/${secretIdeaId}`)
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobDetailAfterJoin.body.idea.groupSlug).toBe('secret-lab');
  expect(bobDetailAfterJoin.body.idea.groupName).toBe('Secret Lab');
});

test('dynamic ideas can be created and filtered by group and ideaType together', async () => {
  const alice = await createUser({ username: 'dynamic_alice', email: 'dynamic_alice@test.local' });

  await request(app)
    .post('/api/groups')
    .set(authHeader(alice.token))
    .send({ name: 'Updates Room', description: 'team updates' })
    .expect(201);

  const dynamicRes = await createIdea(alice.token, {
    title: 'Launch update',
    summary: 'short update',
    ideaType: 'dynamic',
    groupSlug: 'updates-room',
    tags: ['launch'],
  }).expect(201);

  expect(dynamicRes.body.idea.ideaType).toBe('dynamic');
  expect(dynamicRes.body.idea.groupSlug).toBe('updates-room');

  await createIdea(alice.token, {
    title: 'Non dynamic post',
    ideaType: 'daily',
    groupSlug: 'updates-room',
    tags: ['launch'],
  }).expect(201);

  const dynamicList = await request(app)
    .get('/api/ideas?group=updates-room&ideaType=dynamic')
    .set(authHeader(alice.token))
    .expect(200);

  expect(dynamicList.body.ideas).toHaveLength(1);
  expect(dynamicList.body.ideas[0].title).toBe('Launch update');

  const suggestRes = await request(app)
    .get('/api/ideas/suggest?q=Launch')
    .set(authHeader(alice.token))
    .expect(200);

  const suggestionTitles = (suggestRes.body.ideas || []).map((item) => item.title);
  expect(suggestionTitles).toContain('Launch update');
});

test('world group stays implicitly accessible for posting, listing, and detail access', async () => {
  const User = require('../src/models/User');

  const alice = await createUser({ username: 'world_alice', email: 'world_alice@test.local' });

  const worldJoinRes = await request(app)
    .post('/api/groups/world/join')
    .set(authHeader(alice.token))
    .expect(200);

  expect(worldJoinRes.body.joined).toBe(true);

  const afterWorldJoin = await User.findById(alice.user._id).lean();
  expect(afterWorldJoin.joinedGroupSlugs || []).not.toContain('world');

  const worldIdeaRes = await createIdea(alice.token, {
    title: 'World update',
    groupSlug: 'world',
    ideaType: 'dynamic',
  }).expect(201);

  const worldIdeaId = worldIdeaRes.body.idea._id;
  expect(worldIdeaRes.body.idea.groupSlug).toBe('world');

  const anonWorldList = await request(app)
    .get('/api/ideas?group=world&ideaType=dynamic')
    .expect(200);

  expect((anonWorldList.body.ideas || []).map((idea) => idea._id)).toContain(worldIdeaId);

  const anonWorldDetail = await request(app)
    .get(`/api/ideas/${worldIdeaId}`)
    .expect(200);

  expect(anonWorldDetail.body.idea.groupSlug).toBe('world');
});