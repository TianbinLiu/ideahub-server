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

test('home feed can list all idea categories or filter by multiple category tags', async () => {
  const alice = await createUser({ username: 'category_alice', email: 'category_alice@test.local' });

  const dailyRes = await createIdea(alice.token, {
    title: 'Daily category post',
    ideaType: 'daily',
    tags: ['category-daily'],
  }).expect(201);

  const dynamicRes = await createIdea(alice.token, {
    title: 'Dynamic category post',
    ideaType: 'dynamic',
    tags: ['category-dynamic'],
  }).expect(201);

  const allList = await request(app)
    .get('/api/ideas?group=world&sort=new')
    .expect(200);
  const allIds = (allList.body.ideas || []).map((idea) => idea._id);
  expect(allIds).toContain(dailyRes.body.idea._id);
  expect(allIds).toContain(dynamicRes.body.idea._id);

  const multiList = await request(app)
    .get('/api/ideas?group=world&sort=new&ideaTypes=daily,dynamic')
    .expect(200);
  const multiIds = (multiList.body.ideas || []).map((idea) => idea._id);
  expect(multiIds).toContain(dailyRes.body.idea._id);
  expect(multiIds).toContain(dynamicRes.body.idea._id);

  const dynamicOnlyList = await request(app)
    .get('/api/ideas?group=world&sort=new&ideaTypes=dynamic')
    .expect(200);
  const dynamicOnlyIds = (dynamicOnlyList.body.ideas || []).map((idea) => idea._id);
  expect(dynamicOnlyIds).toContain(dynamicRes.body.idea._id);
  expect(dynamicOnlyIds).not.toContain(dailyRes.body.idea._id);
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

test('group invite links join users, create referral records, and follow each other', async () => {
  const Follow = require('../src/models/Follow');
  const Group = require('../src/models/Group');
  const GroupJoinReferral = require('../src/models/GroupJoinReferral');

  const alice = await createUser({ username: 'invite_alice', email: 'invite_alice@test.local' });
  const bob = await createUser({ username: 'invite_bob', email: 'invite_bob@test.local' });

  await request(app)
    .post('/api/groups')
    .set(authHeader(alice.token))
    .send({ name: 'Invite Lab', visibility: 'private', joinCode: 'secret123' })
    .expect(201);

  await request(app)
    .post('/api/groups/invite-lab/join')
    .set(authHeader(bob.token))
    .expect(403);

  const inviteRes = await request(app)
    .post('/api/groups/invite-lab/invites')
    .set(authHeader(alice.token))
    .expect(201);

  expect(inviteRes.body.invite.groupSlug).toBe('invite-lab');
  expect(inviteRes.body.invite.sharePath).toContain('/groups/invite-lab?joinToken=');

  await request(app)
    .post('/api/groups/invite-lab/join')
    .set(authHeader(bob.token))
    .send({ inviteToken: inviteRes.body.invite.token })
    .expect(200);

  const groupAfterJoin = await Group.findOne({ slug: 'invite-lab' }).lean();
  expect(groupAfterJoin.memberCount).toBe(2);

  const referral = await GroupJoinReferral.findOne({ groupSlug: 'invite-lab', invitee: bob.user._id }).lean();
  expect(referral).toBeTruthy();
  expect(String(referral.referrer)).toBe(String(alice.user._id));
  expect(referral.joinMethod).toBe('invite');

  await request(app)
    .post('/api/groups/invite-lab/join')
    .set(authHeader(bob.token))
    .send({ inviteToken: inviteRes.body.invite.token })
    .expect(200);

  expect(await GroupJoinReferral.countDocuments({ groupSlug: 'invite-lab', invitee: bob.user._id })).toBe(1);
  expect(await Follow.countDocuments({ follower: alice.user._id, following: bob.user._id })).toBe(1);
  expect(await Follow.countDocuments({ follower: bob.user._id, following: alice.user._id })).toBe(1);

  const aliceReferrals = await request(app)
    .get(`/api/users/${alice.user._id}/group-referrals`)
    .set(authHeader(alice.token))
    .expect(200);

  expect(aliceReferrals.body.referrals).toHaveLength(1);
  expect(aliceReferrals.body.referrals[0].groupSlug).toBe('invite-lab');
  expect(aliceReferrals.body.referrals[0].invitee.username).toBe('invite_bob');

  const bobReadingAliceReferrals = await request(app)
    .get(`/api/users/${alice.user._id}/group-referrals`)
    .set(authHeader(bob.token))
    .expect(200);

  expect(bobReadingAliceReferrals.body.referrals).toEqual([]);
});

test('public group ideas keep public group visibility in world feed and suggestions', async () => {
  const alice = await createUser({ username: 'public_group_alice', email: 'public_group_alice@test.local' });

  await request(app)
    .post('/api/groups')
    .set(authHeader(alice.token))
    .send({ name: 'Open Studio', visibility: 'public', description: 'public posts' })
    .expect(201);

  const ideaRes = await createIdea(alice.token, {
    title: 'Open studio update',
    summary: 'public group summary',
    groupSlug: 'open-studio',
    ideaType: 'dynamic',
  }).expect(201);

  expect(ideaRes.body.idea.groupSlug).toBe('open-studio');
  expect(ideaRes.body.idea.groupVisibility).toBe('public');

  const worldFeed = await request(app)
    .get('/api/ideas?group=world&ideaType=dynamic')
    .expect(200);

  expect((worldFeed.body.ideas || []).map((idea) => idea._id)).toContain(ideaRes.body.idea._id);

  const anonDetail = await request(app)
    .get(`/api/ideas/${ideaRes.body.idea._id}`)
    .expect(200);

  expect(anonDetail.body.idea.groupSlug).toBe('open-studio');

  const anonSuggest = await request(app)
    .get('/api/ideas/suggest?q=Open%20studio')
    .expect(200);

  expect((anonSuggest.body.ideas || []).map((idea) => idea.title)).toContain('Open studio update');
});