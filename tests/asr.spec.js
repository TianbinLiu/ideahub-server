/**
 * /api/asr 契约测试：上游（火山 openspeech）用 global.fetch 的 mock 替换，只测本路由的收发形状。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
const realFetch = global.fetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  global.fetch = realFetch;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.TTS_API_KEY;
});

async function createUser() {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `asr_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}

function fakeUpstream({ status = 200, apiCode = "20000000", body = { result: { text: "你好，我要退款。" }, audio_info: { duration: 1830 } } } = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (k.toLowerCase() === "x-api-status-code" ? apiCode : k.toLowerCase() === "x-api-message" ? "ok" : null) },
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

const wav = Buffer.alloc(4096, 1);

describe("POST /api/asr", () => {
  it("未登录 401", async () => {
    const res = await request(app).post("/api/asr").set("Content-Type", "audio/wav").send(wav);
    expect(res.status).toBe(401);
  });

  it("没配 key → 501", async () => {
    const { token } = await createUser();
    const res = await request(app).post("/api/asr").set("Authorization", `Bearer ${token}`).set("Content-Type", "audio/wav").send(wav);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe("ASR_NOT_CONFIGURED");
  });

  it("格式不认 / 太短 → 400", async () => {
    process.env.TTS_API_KEY = "test-key";
    const { token } = await createUser();
    const bad = await request(app).post("/api/asr").set("Authorization", `Bearer ${token}`).set("Content-Type", "video/mp4").send(wav);
    expect(bad.status).toBe(400);
    const tiny = await request(app).post("/api/asr").set("Authorization", `Bearer ${token}`).set("Content-Type", "audio/wav").send(Buffer.alloc(10));
    expect(tiny.status).toBe(400);
  });

  it("成功：二进制原样转 base64 发给上游，返回 text 与时长", async () => {
    process.env.TTS_API_KEY = "test-key";
    const calls = fakeUpstream();
    const { user, token } = await createUser();
    const res = await request(app).post("/api/asr").set("Authorization", `Bearer ${token}`).set("Content-Type", "audio/wav").send(wav);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, text: "你好，我要退款。", durationMs: 1830 });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.audio.format).toBe("wav");
    expect(sent.audio.data).toBe(wav.toString("base64"));
    expect(sent.user.uid).toBe(String(user._id));
    expect(calls[0].init.headers["X-Api-Key"]).toBe("test-key");
    expect(calls[0].init.headers["X-Api-Resource-Id"]).toBe("volc.bigasr.auc_turbo");
    expect(calls[0].init.headers["X-Api-Sequence"]).toBe("-1");
  });

  it("?format=mp3 也能指定格式；上游报错 → 502 带 code，不透传提示", async () => {
    process.env.TTS_API_KEY = "test-key";
    fakeUpstream({ status: 200, apiCode: "45000030", body: {} });
    const { token } = await createUser();
    const res = await request(app).post("/api/asr?format=mp3").set("Authorization", `Bearer ${token}`).set("Content-Type", "application/octet-stream").send(wav);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("45000030");
    expect(JSON.stringify(res.body)).not.toMatch(/控制台|开通/);
  });
});
