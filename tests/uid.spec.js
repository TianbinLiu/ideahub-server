// tests/uid.spec.js
// 覆盖：公开数字 UID —— 建号自动带上（pre-save 钩子一处实现）、回填补齐存量、
// 搜索按 UID 精确命中、公开回包带 uid。
//
// ★ 钉「随机而非顺序」：连续建号的 uid 不该单调递增 —— 顺序号会暴露注册先后
//   并允许遍历爬名单，那正是引入 uid 想避免的事（utils/uid.js 头注）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-test-secret-test-sec";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = mongoose.model("User");
  await User.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
});

function mkUser(n) {
  return User.create({
    username: `u_${n}`,
    email: `u_${n}@t.local`,
    passwordHash: "",
  });
}

test("User.create 自动带上 9 位 uid（pre-save 钩子）", async () => {
  const u = await mkUser("a");
  expect(u.uid).toBeGreaterThanOrEqual(100_000_000);
  expect(u.uid).toBeLessThan(1_000_000_000);
});

test("连续建号的 uid 不是顺序号", async () => {
  const uids = [];
  for (let i = 0; i < 5; i++) uids.push((await mkUser(i)).uid);
  const sortedAsc = [...uids].every((v, i) => i === 0 || v > uids[i - 1]);
  expect(sortedAsc).toBe(false); // 5 个随机数恰好严格递增的概率 1/120，可忽略
  expect(new Set(uids).size).toBe(5); // 且互不相同
});

test("回填：老用户（无 uid 字段）能被补齐，幂等", async () => {
  // 绕过钩子造"老数据"：直接 collection 插入
  await User.collection.insertMany([
    { username: "old1", email: "old1@t.local", passwordHash: "" },
    { username: "old2", email: "old2@t.local", passwordHash: "" },
  ]);
  expect(await User.countDocuments({ uid: { $exists: false } })).toBe(2);

  // 与 scripts/backfillUid.js 同一逻辑（脚本连真库，这里在内存库上重演它的核心循环）
  const { generateUid } = require("../src/utils/uid");
  const missing = await User.find({ uid: { $exists: false } }).select("_id");
  for (const u of missing) {
    const uid = await generateUid(async (c) => !!(await User.exists({ uid: c })));
    await User.updateOne({ _id: u._id, uid: { $exists: false } }, { $set: { uid } });
  }
  expect(await User.countDocuments({ uid: { $exists: false } })).toBe(0);
});

test("搜索：9 位纯数字按 UID 精确命中，回包带 uid", async () => {
  const u = await mkUser("findme");
  const res = await request(app).get(`/api/users/search?q=${u.uid}`);
  expect(res.status).toBe(200);
  expect(res.body.users.length).toBeGreaterThanOrEqual(1);
  expect(res.body.users[0].username).toBe("u_findme");
  expect(res.body.users[0].uid).toBe(u.uid);
});

test("公开个人资料回包带 uid", async () => {
  const u = await mkUser("prof");
  const res = await request(app).get(`/api/users/${u._id}`);
  expect(res.status).toBe(200);
  const payload = res.body.user ?? res.body;
  expect(payload.uid).toBe(u.uid);
});

test("GET /api/auth/me 回包带 uid（App 冷启动走的就是这条）", async () => {
  // ★ 回归钉：serializeAuthUser 早就会回 uid，但 /me 是先 .select(...) 再喂给它 ——
  //   select 串里漏掉 uid 的表现是「登录当场有、冷启动后个人页那行 UID 消失」，零报错。
  //   2026-08-29 真机上就是这么发现的。
  const u = await mkUser("me");
  const { signToken } = require("../src/utils/jwt");
  const token = signToken(u);
  const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.user.uid).toBe(u.uid);
});

test("GET /api/me/profile 回包带 uid（hydrateProfile 合并的另一半）", async () => {
  const u = await mkUser("prof2");
  const { signToken } = require("../src/utils/jwt");
  const token = signToken(u);
  const res = await request(app).get("/api/me/profile").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.user.uid).toBe(u.uid);
});
