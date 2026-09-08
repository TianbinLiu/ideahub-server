/**
 * Live2D 模型包的**签名直传**（2026-09-07）：/bundle/sign 出票 + inspect/create 收 bundleRef。
 *
 * ★ 为什么要有这条路：25MB 的 zip 走 multipart 经 Cloudflare 必被 125 秒读超时掐断（手机 5G 上行
 *   实测 0.126MB/s ⇒ 老路真实上限约 15MB）。钉住的三件事：票的形状与三条签名纪律、bundleRef 的归属校验、
 *   以及「用完回收那份 raw 资产」——不回收是零症状的配额泄漏。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const AdmZip = require("adm-zip");
const axios = require("axios");

let mongod;
let app;
let cloudinary;
let bundleService;
const created = new Set();

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
  bundleService = require("../src/services/live2dBundle.service");
});

afterAll(async () => {
  const fs = require("fs/promises");
  const path = require("path");
  for (const id of created) {
    await fs.rm(path.join(__dirname, "..", "uploads", "live2d-market", id), { recursive: true, force: true });
  }
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => jest.restoreAllMocks());

/** 直接建号，绕开 /api/auth/register（本轮只测上传，注册链路有它自己的 spec） */
async function createUser(prefix = "bs") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  created.add(String(user._id));
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

function pngHeader(width, height) {
  const b = Buffer.alloc(64, 0);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** 最小但结构完整的 Cubism 4 包 */
function makeBundle() {
  const zip = new AdmZip();
  const model3 = {
    Version: 3,
    FileReferences: { Moc: "m.moc3", Textures: ["m.2048/texture_00.png"], Motions: { Idle: [{ File: "idle.motion3.json" }] } },
    HitAreas: [{ Id: "HitAreaHead", Name: "Head" }],
  };
  zip.addFile("m/m.model3.json", Buffer.from(JSON.stringify(model3)));
  zip.addFile("m/m.moc3", Buffer.concat([Buffer.from("MOC3"), Buffer.alloc(1020, 1)]));
  zip.addFile("m/m.2048/texture_00.png", pngHeader(2048, 2048));
  zip.addFile("m/idle.motion3.json", Buffer.from(JSON.stringify({ Version: 3, Meta: { Duration: 1, Fps: 30, Loop: true, CurveCount: 0, TotalSegmentCount: 0, TotalPointCount: 0 }, Curves: [] })));
  return zip.toBuffer();
}

/** 把「取回直传资产」这一跳换成本地 zip；返回被调用到的投递地址，供断言 */
function stubDelivery(buffer = makeBundle()) {
  const seen = [];
  jest.spyOn(axios, "get").mockImplementation(async (url) => {
    seen.push(url);
    return { status: 200, data: buffer };
  });
  return seen;
}

describe("POST /api/live2d-models/bundle/sign", () => {
  it("未登录 401；票的形状与三条签名纪律都在，签名可复算", async () => {
    expect((await request(app).post("/api/live2d-models/bundle/sign")).status).toBe(401);
    const { user, token } = await createUser();
    const res = await request(app).post("/api/live2d-models/bundle/sign").set(auth(token)).send({}).expect(200);
    expect(res.body.ok).toBe(true);
    // ★ 必须是 raw/upload：zip 不是 video
    expect(res.body.uploadUrl).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/[^/]+\/raw\/upload$/);
    expect(res.body.publicId).toMatch(new RegExp(`^ideahub/live2d-bundles/${user._id}-\\d+$`));
    expect(res.body.params.public_id).toBe(res.body.publicId);
    expect(res.body.params.overwrite).toBe(false);
    // ★ 把这张票钉死在 raw/zip 上的唯一手段（resource_type 不进签名）
    expect(res.body.params.allowed_formats).toBe("zip");
    expect(res.body.chunkBytes).toBe(6_000_000);
    expect(res.body.maxSizeBytes).toBe(25 * 1024 * 1024);
    const { api_key, signature, ...signed } = res.body.params;
    expect(api_key).toBeTruthy();
    expect(cloudinary.utils.api_sign_request(signed, cloudinary.config().api_secret)).toBe(signature);
  });

  it("没配 Cloudinary 时 503，不发一张签不了名的票", async () => {
    const { token } = await createUser();
    const real = cloudinary.config().api_secret;
    cloudinary.config({ api_secret: "" });
    try {
      const res = await request(app).post("/api/live2d-models/bundle/sign").set(auth(token)).send({}).expect(503);
      expect(res.body.ok).toBe(false);
    } finally {
      cloudinary.config({ api_secret: real });
    }
  });
});

describe("bundleRef：inspect 与 create 都能用直传的包", () => {
  it("inspect 收 bundleRef → 能力档案与自动映射照常；**不**回收（create 还要用同一份）", async () => {
    const { user, token } = await createUser();
    const seen = stubDelivery();
    const destroy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
    const ref = `ideahub/live2d-bundles/${user._id}-1757000000000`;
    const res = await request(app).post("/api/live2d-models/inspect").set(auth(token)).send({ bundleRef: ref }).expect(200);
    expect(res.body.capabilities.hitAreas).toEqual(["Head"]);
    expect(res.body.mapping.idle).toBe("Idle");
    // ★ 取回必须走**签名下载地址**：raw 的公开投递在本账号上是 401（2026-09-07 线上实测），
    //   而且 public_id 要带扩展名、format 传空（拆成 base+zip 会 404）。签名是本地算的，不花 Admin API 配额。
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`https://api.cloudinary.com/v1_1/${cloudinary.config().cloud_name}/raw/download`);
    expect(seen[0]).toContain(encodeURIComponent(`${ref}.zip`));
    expect(seen[0]).toMatch(/[?&]signature=/);
    expect(seen[0]).not.toContain("res.cloudinary.com");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("create 收 bundleRef → 建号成功，并把那份 raw 资产回收掉（带 .zip、resource_type:raw）", async () => {
    const { user, token } = await createUser();
    stubDelivery();
    const destroy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
    const ref = `ideahub/live2d-bundles/${user._id}-1757000000001`;
    const res = await request(app)
      .post("/api/live2d-models")
      .set(auth(token))
      .send({ name: "直传的模型", shared: true, selfMade: true, bundleRef: ref, bundleName: "我的模型.zip" })
      .expect(201);
    expect(res.body.model.name).toBe("直传的模型");
    expect(res.body.model.bundleName).toBe("我的模型.zip");
    expect(res.body.model.capabilities.badges).toEqual(expect.arrayContaining(["motions", "touch"]));
    expect(res.body.model.modelJsonUrl).toMatch(/\/uploads\/live2d-market\/.+\/m\.model3\.json$/);
    expect(destroy).toHaveBeenCalledWith(`${ref}.zip`, expect.objectContaining({ resource_type: "raw" }));
  });

  it("别人的 ref / 形状不对的 ref 一律 400，且一次都不去取文件", async () => {
    const a = await createUser("ba");
    const b = await createUser("bb");
    const seen = stubDelivery();
    const bad = [
      `ideahub/live2d-bundles/${b.user._id}-1757000000002`, // 别人的
      `ideahub/live2d-bundles/${a.user._id}-1757/x`, // 多一层
      `ideahub/template-videos/${a.user._id}-1757000000003`, // 别的目录
      `ideahub/live2d-bundles/${a.user._id}-abc`, // 形状不对
    ];
    for (const ref of bad) {
      const res = await request(app).post("/api/live2d-models/inspect").set(auth(a.token)).send({ bundleRef: ref });
      expect(res.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
    // 既没文件也没 bundleRef → 400
    expect((await request(app).post("/api/live2d-models/inspect").set(auth(a.token)).send({})).status).toBe(400);
  });

  it("Cloudinary 上没有这份（上传没真的完成）→ 400 + 说清是上传没完成", async () => {
    const { user, token } = await createUser();
    jest.spyOn(axios, "get").mockResolvedValue({ status: 404, data: Buffer.alloc(0) });
    const res = await request(app)
      .post("/api/live2d-models/inspect")
      .set(auth(token))
      .send({ bundleRef: `ideahub/live2d-bundles/${user._id}-1757000000004` })
      .expect(400);
    expect(res.body.message).toMatch(/上传没真的完成/);
  });

  it("超过 25MB → 400（直传那条路上 multer 不在链上，体积闸靠服务层补）", async () => {
    const { user, token } = await createUser();
    jest.spyOn(axios, "get").mockRejectedValue(new Error("maxContentLength size of 26214400 exceeded"));
    const res = await request(app)
      .post("/api/live2d-models/inspect")
      .set(auth(token))
      .send({ bundleRef: `ideahub/live2d-bundles/${user._id}-1757000000005` })
      .expect(400);
    expect(res.body.message).toMatch(/25MB/);
  });
});
