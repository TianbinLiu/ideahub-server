// POST /api/uploads/media/sign + /confirm —— 发布成片的签名直传（2026-09-06）。
//
// ★★ 为什么有这条路：老路 /media 整份 multipart 经 CF → nginx → Node → Cloudinary 三段串行，慢网上
//   10MB 级成片经常一个字节都到不了 Node，客户端只能在 180 秒上限上放弃（主人真机）。钉住：
//   票的形状与安全面（public_id 服务端签死、overwrite:false、allowed_formats）、验收只认本账号目录、
//   验收不过就 destroy、成功回 mediaUrl。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let cloudinary;
let token;
let userId;
let errorSpy;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "testcloud";
  process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "123456";
  process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "shh";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  ({ cloudinary } = require("../src/config/cloudinary"));
  const name = `umd_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  token = res.body.token;
  const User = require("../src/models/User");
  userId = String((await User.findOne({ username: name }))._id);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  errorSpy.mockRestore();
});

const sign = () => request(app).post("/api/uploads/media/sign").set("Authorization", `Bearer ${token}`).send({});
const confirm = (publicId) =>
  request(app).post("/api/uploads/media/confirm").set("Authorization", `Bearer ${token}`).send({ publicId });

test("sign：public_id 落在成片目录、由服务端签死；overwrite:false 与 allowed_formats 都在签名里", async () => {
  const res = await sign().expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.uploadUrl).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/[^/]+\/video\/upload$/);
  expect(res.body.publicId).toMatch(new RegExp(`^ideahub/workshop-media/${userId}-\\d+$`));
  expect(res.body.params.public_id).toBe(res.body.publicId);
  expect(res.body.params.overwrite).toBe(false);
  expect(res.body.params.allowed_formats).toBe("mp4,webm,mov");
  expect(typeof res.body.params.signature).toBe("string");
  expect(res.body.params.api_key).toBeTruthy();
  expect(res.body.chunkBytes).toBe(6_000_000);
  expect(res.body.maxSizeBytes).toBe(100 * 1024 * 1024);
  // 签名要能按同一组参数复算出来（客户端原样转发这几个字段）
  const { api_key, signature, ...signed } = res.body.params;
  expect(cloudinary.utils.api_sign_request(signed, cloudinary.config().api_secret)).toBe(signature);
});

test("sign：没配 Cloudinary 时 503，不发一张签不了名的票", async () => {
  jest.spyOn(cloudinary, "config").mockReturnValue({});
  await sign().expect(503);
});

test("confirm：别人目录 / 别的形状一律 400，一次 Admin API 都不打", async () => {
  const spy = jest.spyOn(cloudinary.api, "resource");
  await confirm("ideahub/workshop-media/000000000000000000000000-1700000000000").expect(400);
  await confirm(`ideahub/template-videos/${userId}-1700000000000`).expect(400);
  await confirm(`ideahub/workshop-media/${userId}-1700000000000/x`).expect(400);
  expect(spy).not.toHaveBeenCalled();
});

test("confirm：Cloudinary 上没有这份（上传没完成）→ 404 + 中文原因", async () => {
  jest.spyOn(cloudinary.api, "resource").mockRejectedValue({ error: { http_code: 404, message: "not found" } });
  const res = await confirm(`ideahub/workshop-media/${userId}-1700000000000`).expect(404);
  expect(res.body.message).toMatch(/没真的完成/);
});

test("confirm：格式不对 / 超过 100MB → destroy + 400", async () => {
  const destroy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
  jest
    .spyOn(cloudinary.api, "resource")
    .mockResolvedValueOnce({ secure_url: "https://x/y.avi", public_id: "p", format: "avi", bytes: 1000 })
    .mockResolvedValueOnce({ secure_url: "https://x/y.mp4", public_id: "p", format: "mp4", bytes: 101 * 1024 * 1024 });
  const a = await confirm(`ideahub/workshop-media/${userId}-1700000000001`).expect(400);
  expect(a.body.message).toMatch(/格式/);
  const b = await confirm(`ideahub/workshop-media/${userId}-1700000000002`).expect(400);
  expect(b.body.message).toMatch(/100MB/);
  expect(destroy).toHaveBeenCalledTimes(2);
});

test("confirm：验收通过回 mediaUrl 与服务端取回的元数据", async () => {
  const pid = `ideahub/workshop-media/${userId}-1700000000003`;
  jest.spyOn(cloudinary.api, "resource").mockResolvedValue({
    secure_url: `https://res.cloudinary.com/testcloud/video/upload/v1/${pid}.webm`,
    public_id: pid,
    format: "webm",
    bytes: 10_300_000,
    duration: 41.2,
    width: 1280,
    height: 720,
  });
  const res = await confirm(pid).expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.mediaUrl).toMatch(/workshop-media/);
  expect(res.body.bytes).toBe(10_300_000);
  expect(res.body.duration).toBe(41.2);
});

test("老路 /media 一个字不变：仍然收 multipart", async () => {
  jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => ({
    end: () => cb(null, { secure_url: "https://res.cloudinary.com/testcloud/video/upload/v1/ideahub/workshop-media/x.webm" }),
  }));
  const res = await request(app)
    .post("/api/uploads/media")
    .set("Authorization", `Bearer ${token}`)
    .attach("media", Buffer.from("fake-webm"), { filename: "film.webm", contentType: "video/webm" })
    .expect(200);
  expect(res.body.mediaUrl).toMatch(/workshop-media/);
});
