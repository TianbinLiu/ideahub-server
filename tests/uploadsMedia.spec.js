// POST /api/uploads/media —— 发布时把剪辑页导出的成片交给 Cloudinary 的那一跳。
//
// ★★ 2026-09-05 主人真机：发布回「Server error」，pm2 一行日志没有，Cloudinary 上一个字节都没到。
//   这条路原来把 upload_stream 的错误直接 next(err) → 生产压成 Server error；SDK 默认 60s 超时
//   在 ECS → Cloudinary 跨境传 10~20MB 时常掐死在半途。钉住三件事：带 100s 超时、失败回 502 +
//   中文原因 + 落日志、成功路一个字不变。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let cloudinary;
let token;
let uploadStreamSpy;
let errorSpy;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  ({ cloudinary } = require("../src/config/cloudinary"));
  const name = `um_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  token = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (uploadStreamSpy) uploadStreamSpy.mockRestore();
  uploadStreamSpy = null;
  errorSpy.mockRestore();
});

const post = () =>
  request(app)
    .post("/api/uploads/media")
    .set("Authorization", `Bearer ${token}`)
    .attach("media", Buffer.from("fake-webm"), { filename: "film.webm", contentType: "video/webm" });

test("★★ Cloudinary 那一跳出错 → 502 + 中文原因 + 落日志（不再是一句未记录的 Server error）", async () => {
  let seenOpts;
  uploadStreamSpy = jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => {
    seenOpts = opts;
    return { end: () => cb({ message: "Request Timeout", http_code: 499 }) };
  });
  const res = await post();
  expect(res.status).toBe(502);
  expect(res.body.code).toBe("UPSTREAM_UPLOAD_FAILED");
  expect(res.body.message).toContain("成片没能存到云端");
  expect(res.body.message).toContain("Request Timeout");
  expect(res.body.message).toContain("立即重试");
  // 超时不再是 SDK 默认 60s；且要在 Cloudflare 125s 读超时之内
  expect(seenOpts.timeout).toBe(100_000);
  expect(seenOpts.timeout).toBeLessThan(125_000);
  expect(seenOpts.resource_type).toBe("video");
  expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/media 转存 Cloudinary 失败/);
});

test("成功路一个字不变：回 mediaUrl 与元数据", async () => {
  uploadStreamSpy = jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => ({
    end: () => cb(null, { secure_url: `https://res.cloudinary.com/demo/video/upload/${opts.public_id}.webm` }),
  }));
  const res = await post();
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.mediaUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
  expect(res.body.resourceType).toBe("video");
});
