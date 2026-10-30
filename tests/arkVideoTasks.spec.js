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

test("样片（draft:true）登记成样片、活 8 天；成片记下是哪条样片转的、时长画幅取自结论；实扣的数一起记", async () => {
  const ULTRA = "doubao-seedance-2-5-260628";
  const draftBody = { model: ULTRA, content: [{ type: "text", text: "样片" }], duration: 4, ratio: "9:16", resolution: "480p", draft: true };
  expect(await svc.recordVideoTask({ userId, body: draftBody, responseText: JSON.stringify({ id: "cgt-d-1" }), r2v: null, costTokens: 180_621 })).toBe(true);
  const d = await ArkVideoTask.findOne({ taskId: "cgt-d-1" }).lean();
  expect(d).toMatchObject({ draft: true, durationSec: 4, resolution: "480p", costTokens: 180_621 });
  expect(d.expireAt.getTime() - d.createdAt.getTime()).toBeGreaterThanOrEqual(ArkVideoTask.DRAFT_TTL_MS - 5000);

  // 普通任务 48 小时
  const n = await ArkVideoTask.findOne({ taskId: "cgt-20260906174812-zrv9b" }).lean();
  expect(n.draft).toBe(false);
  expect(Math.abs(n.expireAt.getTime() - n.createdAt.getTime() - ArkVideoTask.TTL_MS)).toBeLessThan(5000);

  // 样片第二步：请求体里没有时长 / 画幅（方舟规定沿用样片）—— 从结论里取
  const finalBody = { model: ULTRA, content: [{ type: "draft_task", draft_task: { id: "cgt-d-1" } }], resolution: "1080p", watermark: false };
  const draftFinal = { draftTaskId: "cgt-d-1", durationSec: 4, ratio: "9:16" };
  expect(await svc.recordVideoTask({ userId, body: finalBody, responseText: JSON.stringify({ id: "cgt-f-1" }), r2v: null, draftFinal, costTokens: 997_920 })).toBe(true);
  const f = await ArkVideoTask.findOne({ taskId: "cgt-f-1" }).lean();
  expect(f).toMatchObject({ draft: false, draftOf: "cgt-d-1", durationSec: 4, ratio: "9:16", resolution: "1080p", costTokens: 997_920, prompt: "" });

  // 列表把三位带出去（老客户端不认，只是不显示）
  const res = await request(app).get("/api/ark/video-tasks").set("Authorization", `Bearer ${token}`).expect(200);
  const byId = Object.fromEntries(res.body.tasks.map((t) => [t.taskId, t]));
  expect(byId["cgt-d-1"]).toMatchObject({ draft: true, costTokens: 180_621 });
  expect(byId["cgt-f-1"]).toMatchObject({ draft: false, draftOf: "cgt-d-1" });
});

test("findOwnDraft：只认本人 + 样片；id 先过字符集", async () => {
  const other = new mongoose.Types.ObjectId();
  await ArkVideoTask.create({ userId: other, taskId: "cgt-d-other", model: "doubao-seedance-2-5-260628", draft: true, durationSec: 4 });
  expect(await svc.findOwnDraft("cgt-d-1", userId)).toMatchObject({ taskId: "cgt-d-1", durationSec: 4 });
  expect(await svc.findOwnDraft("cgt-d-other", userId)).toBeNull(); // 别人的
  expect(await svc.findOwnDraft("cgt-f-1", userId)).toBeNull(); // 不是样片
  expect(await svc.findOwnDraft("../x", userId)).toBeNull();
  expect(await svc.findOwnDraft({ $ne: null }, userId)).toBeNull(); // 不许把查询对象当 id 塞进来
});

test("migrateExpiry：删掉老的 createdAt TTL 索引、给老行补 expireAt；再跑一遍什么都不做", async () => {
  // 造线上的老样子：createdAt 上的 48 小时 TTL 索引 + 一条没有 expireAt 的老行
  await ArkVideoTask.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 48 * 3600 });
  const createdAt = new Date(Date.now() - 3600 * 1000);
  await ArkVideoTask.collection.insertOne({ userId, taskId: "cgt-legacy-1", model: "doubao-seedance-2-5-260628", createdAt, updatedAt: createdAt });

  const first = await svc.migrateExpiry();
  expect(first.dropped).toBe(true);
  expect(first.backfilled).toBeGreaterThanOrEqual(1);
  const idx = await ArkVideoTask.collection.indexes();
  expect(idx.some((i) => i.key.createdAt === 1 && Object.keys(i.key).length === 1)).toBe(false);
  expect(idx.some((i) => i.key.expireAt === 1 && i.expireAfterSeconds === 0)).toBe(true);
  const legacy = await ArkVideoTask.findOne({ taskId: "cgt-legacy-1" }).lean();
  expect(legacy.expireAt.getTime()).toBe(createdAt.getTime() + ArkVideoTask.TTL_MS);

  const again = await svc.migrateExpiry();
  expect(again).toEqual({ dropped: false, backfilled: 0 });
});
