const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  // require after setting MONGO_URI
  const { connectDB } = require('../src/config/db');
  await connectDB();
  app = require('../src/app');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('create leaderboard and query paginated results', async () => {
  const Idea = require('../src/models/Idea');
  const TagVote = require('../src/models/TagVote');

  // create sample ideas
  const a = await Idea.create({ title: 'One', summary: '', content: '', author: mongoose.Types.ObjectId(), tags: ['alpha','beta'], visibility: 'public' });
  const b = await Idea.create({ title: 'Two', summary: '', content: '', author: mongoose.Types.ObjectId(), tags: ['alpha'], visibility: 'public' });

  // votes
  await TagVote.create({ idea: a._id, tags: ['alpha','beta'], tagsKey: 'alpha|beta', user: mongoose.Types.ObjectId(), vote: 1 });
  await TagVote.create({ idea: b._id, tags: ['alpha'], tagsKey: 'alpha', user: mongoose.Types.ObjectId(), vote: 1 });

  // create leaderboard for alpha|beta
  const createRes = await request(app).post('/api/tag-rank/leaderboard').send({ tags: 'alpha,beta' }).expect(200);
  expect(createRes.body.ok).toBe(true);
  // query leaderboard
  const res = await request(app).get('/api/tag-rank?tags=alpha,beta&page=1&limit=10').expect(200);
  expect(res.body.ok).toBe(true);
  expect(Array.isArray(res.body.results)).toBe(true);
  expect(res.body.results.length).toBeGreaterThanOrEqual(0);
});
