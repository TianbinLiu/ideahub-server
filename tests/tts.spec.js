/**
 * /api/tts 契约测试：上游（豆包 openspeech V3 SSE）用 global.fetch 的 mock 替换，只测本路由的收发形状——
 * 混音的两种输入形状（老 { id, w } / 新 { voiceId, weight }）都要发成 speaker=custom_mix_bigtts + mix_speaker
 * （mix_factor 之和 = 1、最多 3 味）且走 seed-tts-1.0；单音色按 uranus 与否分代。
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

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser() {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `tts_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}

const MP3 = Buffer.from("mp3-bytes");

/** 假上游：两帧音频 + 结束帧（20000000 不是错误）；或指定一个错误码 */
function fakeUpstream({ errCode = 0 } = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    const frames = errCode
      ? [{ code: errCode, message: "upstream says no" }]
      : [
          { code: 0, message: "", data: MP3.subarray(0, 4).toString("base64") },
          { code: 0, message: "", data: MP3.subarray(4).toString("base64") },
          { code: 20000000, message: "OK" },
        ];
    const sse = frames.map((f) => `event: ${f.code ? 153 : 352}\ndata: ${JSON.stringify(f)}\n`).join("\n");
    return { ok: true, status: 200, text: async () => sse };
  };
  return calls;
}

/** audio/mpeg 不是 supertest 会自动解析的类型：自己攒成 Buffer */
function binary(req) {
  return req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
}

const F = "zh_female_gaolengyujie_moon_bigtts";
const M = "zh_male_shaonianzixin_moon_bigtts";
const C = "zh_female_cancan_mars_bigtts";
const sum = (list) => +list.reduce((a, b) => a + b, 0).toFixed(3);

describe("GET /api/tts/voices", () => {
  it("2.0 目录 + 23 个可混音的 1.0 音色 + 上限", async () => {
    const res = await request(app).get("/api/tts/voices");
    expect(res.status).toBe(200);
    expect(res.body.maxMixVoices).toBe(3);
    expect(res.body.voices.every((v) => v.generation === "2.0" && v.mixable === false && /uranus/.test(v.id))).toBe(true);
    expect(res.body.mixable).toHaveLength(23);
    expect(res.body.mixable.every((v) => v.generation === "1.0" && v.mixable === true && /_(moon|mars)_bigtts$/.test(v.id))).toBe(true);
    expect(res.body.mixable.filter((v) => v.gender === "female")).toHaveLength(16);
    expect(res.body.mixable.filter((v) => v.gender === "male")).toHaveLength(7);
    expect(res.body.mixable.find((v) => v.id === F)).toEqual({ id: F, name: "高冷御姐", gender: "female", generation: "1.0", mixable: true });
    expect(new Set(res.body.mixable.map((v) => v.id)).size).toBe(23);
  });
});

describe("POST /api/tts", () => {
  it("未登录 401；没配 key 501；空文本 400", async () => {
    expect((await request(app).post("/api/tts").send({ text: "你好" })).status).toBe(401);
    const { token } = await createUser();
    expect((await request(app).post("/api/tts").set(auth(token)).send({ text: "你好" })).status).toBe(501);
    process.env.TTS_API_KEY = "test-key";
    expect((await request(app).post("/api/tts").set(auth(token)).send({ text: "  " })).status).toBe(400);
  });

  it("老形状 mix [{ id, w }] → custom_mix_bigtts + mix_speaker（mix_factor 之和 = 1）+ seed-tts-1.0，回 audio/mpeg", async () => {
    process.env.TTS_API_KEY = "test-key";
    const calls = fakeUpstream();
    const { user, token } = await createUser();
    const res = await binary(
      request(app)
        .post("/api/tts")
        .set(auth(token))
        .send({ text: "你好呀", mix: [{ id: F, w: 1 }, { id: M, w: 1 }, { id: C, w: 1 }], expressive: true, instruct: "轻一点", rate: -10, pitch: 2 })
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(res.body, MP3)).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse");
    expect(calls[0].init.headers["X-Api-Key"]).toBe("test-key");
    expect(calls[0].init.headers["X-Api-Resource-Id"]).toBe("seed-tts-1.0");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.user.uid).toBe(String(user._id));
    expect(sent.req_params.text).toBe("你好呀");
    expect(sent.req_params.speaker).toBe("custom_mix_bigtts");
    const speakers = sent.req_params.mix_speaker.speakers;
    expect(speakers.map((s) => s.source_speaker)).toEqual([F, M, C]);
    expect(speakers.map((s) => s.mix_factor)).toEqual([0.333, 0.333, 0.334]);
    expect(sum(speakers.map((s) => s.mix_factor))).toBe(1);
    // 混音不走表现力模型；1.0 不吃 context_texts；语速 / 音高照常
    expect(sent.req_params.model).toBeUndefined();
    expect(sent.req_params.audio_params.speech_rate).toBe(-10);
    const additions = JSON.parse(sent.req_params.additions);
    expect(additions.context_texts).toBeUndefined();
    expect(additions.use_tag_parser).toBeUndefined();
    expect(additions.post_process).toEqual({ pitch: 2 });
  });

  it("新形状 mix [{ voiceId, weight }]（数字人设置里的配方）同样成 mix_speaker；第 4 味丢掉后再归一", async () => {
    process.env.TTS_API_KEY = "test-key";
    const calls = fakeUpstream();
    const { token } = await createUser();
    const res = await binary(
      request(app)
        .post("/api/tts")
        .set(auth(token))
        .send({
          text: "你好",
          voice: "zh_female_vv_uranus_bigtts",
          mix: [
            { voiceId: F, weight: 3 },
            { voiceId: M, weight: 1 },
            { voiceId: C, weight: 4 },
            { voiceId: "zh_female_meilinvyou_moon_bigtts", weight: 8 },
          ],
        })
    );
    expect(res.status).toBe(200);
    expect(calls[0].init.headers["X-Api-Resource-Id"]).toBe("seed-tts-1.0");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.req_params.speaker).toBe("custom_mix_bigtts");
    expect(sent.req_params.mix_speaker.speakers).toEqual([
      { source_speaker: F, mix_factor: 0.375 },
      { source_speaker: M, mix_factor: 0.125 },
      { source_speaker: C, mix_factor: 0.5 },
    ]);
    expect(sum(sent.req_params.mix_speaker.speakers.map((s) => s.mix_factor))).toBe(1);
  });

  it("单音色：2.0 走 seed-tts-2.0 + 表现力模型 + context_texts；1.0 单音色走 seed-tts-1.0；空 mix 不算混音", async () => {
    process.env.TTS_API_KEY = "test-key";
    const calls = fakeUpstream();
    const { token } = await createUser();
    await binary(request(app).post("/api/tts").set(auth(token)).send({ text: "你好", voice: "zh_female_vv_uranus_bigtts", expressive: true, instruct: "冷淡", mix: [] })).expect(200);
    expect(calls[0].init.headers["X-Api-Resource-Id"]).toBe("seed-tts-2.0");
    const sent20 = JSON.parse(calls[0].init.body);
    expect(sent20.req_params.speaker).toBe("zh_female_vv_uranus_bigtts");
    expect(sent20.req_params.mix_speaker).toBeUndefined();
    expect(sent20.req_params.model).toBe("seed-tts-2.0-expressive");
    const additions = JSON.parse(sent20.req_params.additions);
    expect(additions.context_texts).toEqual(["冷淡"]);
    expect(additions.use_tag_parser).toBe(true);

    await binary(request(app).post("/api/tts").set(auth(token)).send({ text: "你好", voice: F, expressive: true, instruct: "冷淡" })).expect(200);
    expect(calls[1].init.headers["X-Api-Resource-Id"]).toBe("seed-tts-1.0");
    const sent10 = JSON.parse(calls[1].init.body);
    expect(sent10.req_params.speaker).toBe(F);
    expect(sent10.req_params.model).toBe("seed-tts-2.0-expressive");
    expect(JSON.parse(sent10.req_params.additions).context_texts).toBeUndefined();
  });

  it("上游没回音频（55000000）→ 502 带 code，不透传开通提示", async () => {
    process.env.TTS_API_KEY = "test-key";
    fakeUpstream({ errCode: 55000000 });
    const { token } = await createUser();
    const res = await request(app).post("/api/tts").set(auth(token)).send({ text: "你好", mix: [{ voiceId: F, weight: 1 }] });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ message: "tts failed", code: 55000000 });
  });
});
