/**
 * 全站挂件（SiteLive2D）的组件设置：默认模型从 Live2D 官方示例 Hiyori 换成官方看板娘小梦（2026-09-18）。
 *
 * 约定与模型市场 `official-mascot` 同一个：**modelJsonUrl 空串 = 用官方看板娘**，官网把空串解析成随站点打包的
 * /live2d/mascot/mascot.model3.json（服务端不知道官网的域名，所以不存地址）。
 * 为什么换：按 Live2D Free Material License，营收达到门槛的运营方不能把示例数据放在公开网站上。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const LEGACY_HIYORI = "https://fastly.jsdelivr.net/gh/Live2D/CubismWebSamples/Samples/Resources/Hiyori/Hiyori.model3.json";

let mongod;
let app;
let User;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function createUser(live2d) {
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({
    username: `c2_${random}`,
    email: `${random}@test.local`,
    role: "user",
    passwordHash: "hashed",
    ...(live2d ? { siteComponents: { live2d } } : {}),
  });
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe("GET /api/me/components：默认模型", () => {
  it("没存过设置的用户 → modelJsonUrl 空串（= 官方看板娘小梦），不再是 Hiyori", async () => {
    const { token } = await createUser();
    const res = await request(app).get("/api/me/components").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.components.live2d).toMatchObject({ enabled: true, source: "remote", modelJsonUrl: "" });
  });

  it("库里存着**旧的默认地址**（在设置页点过保存的人，存进去的正是 Hiyori）→ 读出来也是空串", async () => {
    const { token } = await createUser({ enabled: true, source: "remote", modelJsonUrl: LEGACY_HIYORI });
    const res = await request(app).get("/api/me/components").set(auth(token));
    expect(res.body.components.live2d.modelJsonUrl).toBe("");
  });

  it("用户**自己**填的别的地址原样保留（只认逐字等于旧默认值的那一个）", async () => {
    const own = "https://cdn.example.com/models/my-girl/my-girl.model3.json";
    const { token } = await createUser({ enabled: true, source: "remote", modelJsonUrl: own });
    const res = await request(app).get("/api/me/components").set(auth(token));
    expect(res.body.components.live2d.modelJsonUrl).toBe(own);
  });
});

describe("PUT /api/me/components：保存", () => {
  it("modelJsonUrl 留空 → 收下（= 用官方看板娘），落库也是空串", async () => {
    const { user, token } = await createUser();
    const res = await request(app)
      .put("/api/me/components")
      .set(auth(token))
      .send({ live2d: { enabled: true, source: "remote", modelJsonUrl: "" } });
    expect(res.status).toBe(200);
    expect(res.body.components.live2d.modelJsonUrl).toBe("");
    const db = await User.findById(user._id).lean();
    expect(db.siteComponents.live2d.modelJsonUrl).toBe("");
  });

  it("填了就照旧校验：不是 http(s) 的 json 地址 → 400；合法地址 → 原样收下", async () => {
    const { token } = await createUser();
    const bad = await request(app).put("/api/me/components").set(auth(token)).send({ live2d: { enabled: true, source: "remote", modelJsonUrl: "not a url" } });
    expect(bad.status).toBe(400);
    const url = "https://cdn.example.com/m/m.model3.json";
    const ok = await request(app).put("/api/me/components").set(auth(token)).send({ live2d: { enabled: true, source: "remote", modelJsonUrl: url } });
    expect(ok.status).toBe(200);
    expect(ok.body.components.live2d.modelJsonUrl).toBe(url);
  });

  it("只改别的组件（不带 live2d）时，存着旧默认地址的人顺手被写成空串", async () => {
    const { user, token } = await createUser({ enabled: true, source: "remote", modelJsonUrl: LEGACY_HIYORI });
    const res = await request(app).put("/api/me/components").set(auth(token)).send({ tagRank: { enabled: false } });
    expect(res.status).toBe(200);
    const db = await User.findById(user._id).lean();
    expect(db.siteComponents.live2d.modelJsonUrl).toBe("");
  });
});
