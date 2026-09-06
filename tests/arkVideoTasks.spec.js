// 视频任务服务端登记 + GET /api/ark/video-tasks（2026-09-06，见 models/ArkVideoTask 的 ★★）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let token;
let userId;
let svc;
let ArkVideoTask;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  svc = require("../src/services/arkVideoTask.service");
  ArkVideoTask = require("../src/models/ArkVideoTask");
  const name = `avt_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  token = res.body.token;
  const User = require("../src/models/User");
  userId = (await User.findOne({ username: name }))._id;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const body = {
  model: "doubao-seedance-2-5-260628",
  content: [{ type: "text", text: "以参考视频复刻原视频的人物站位、动作、节奏卡点" }, { type: "image_url", image_url: { url: "https://x/y.jpg" } }],
  duration: 20,
  ratio: "16:9",
  resolution: "720p",
};

test("recordVideoTask：受理即记一条，摘要只留给人认的那几样；重放不算事；Seed3D / 没有任务 id 不记", async () => {
  expect(await svc.recordVideoTask({ userId, body, responseText: JSON.stringify({ id: "cgt-20260906174812-zrv9b" }), r2v: null })).toBe(true);
  const row = await ArkVideoTask.findOne({ taskId: "cgt-20260906174812-zrv9b" }).lean();
  expect(row).toMatchObject({ model: "doubao-seedance-2-5-260628", durationSec: 20, ratio: "16:9", resolution: "720p", r2v: false });
  expect(row.prompt).toMatch(/^以参考视频复刻/);
  // 重放（同一个任务 id 再记一次）→ 唯一索引撞上，当成功
  expect(await svc.recordVideoTask({ userId, body, responseText: JSON.stringify({ id: "cgt-20260906174812-zrv9b" }), r2v: null })).toBe(true);
  expect(await ArkVideoTask.countDocuments({ taskId: "cgt-20260906174812-zrv9b" })).toBe(1);
  expect(await svc.recordVideoTask({ userId, body: { ...body, model: "doubao-seed3d-1-0" }, responseText: JSON.stringify({ id: "cgt-x" }), r2v: null })).toBe(false);
  expect(await svc.recordVideoTask({ userId, body, responseText: JSON.stringify({ error: "nope" }), r2v: null })).toBe(false);
  expect(await svc.recordVideoTask({ userId, body, responseText: "<html>", r2v: null })).toBe(false);
});

test("GET /video-tasks：只给本账号、最近 24 小时的，新的在前", async () => {
  const other = new mongoose.Types.ObjectId();
  await ArkVideoTask.create({ userId: other, taskId: "cgt-other-1", model: "doubao-seedance-2-5-260628" });
  await ArkVideoTask.create({ userId, taskId: "cgt-mine-old", model: "doubao-seedance-2-5-260628" });
  // timestamps 开着时 mongoose 把 createdAt 当不可变字段、$set 会被剥掉 —— 走原生驱动改
  await ArkVideoTask.collection.updateOne({ taskId: "cgt-mine-old" }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
  await ArkVideoTask.create({ userId, taskId: "cgt-mine-new", model: "doubao-seedance-2-5-260628", durationSec: 5, ratio: "9:16" });
  const res = await request(app).get("/api/ark/video-tasks").set("Authorization", `Bearer ${token}`).expect(200);
  const ids = res.body.tasks.map((t) => t.taskId);
  expect(ids[0]).toBe("cgt-mine-new");
  expect(ids).toContain("cgt-20260906174812-zrv9b");
  expect(ids).not.toContain("cgt-other-1");
  expect(ids).not.toContain("cgt-mine-old");
  expect(res.body.tasks[0]).toMatchObject({ durationSec: 5, ratio: "9:16", r2v: false });
  await request(app).get("/api/ark/video-tasks").expect(401);
});
