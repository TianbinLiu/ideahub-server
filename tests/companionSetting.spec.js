/**
 * 数字人设置（/api/companion/settings）+ 人格「音频」板块 + 两条聊天链路的人设注入。
 * 上游 LLM 用 jest.mock 换掉并记录收到的 system prompt —— 测的是"装了人格提示词多了哪一段、TTS 指令怎么合并"。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mockLastMessages = null;
jest.mock("../src/services/aiClient", () => {
  const actual = jest.requireActual("../src/services/aiClient");
  return {
    ...actual,
    hasAiKey: () => true,
    aiChatStream: async function* (messages) {
      mockLastMessages = messages;
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield "[happy][face:happy][action:wave] 你好呀。";
    },
  };
});

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  delete process.env.COMPANION_TTS_VOICE;
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser(prefix = "cs") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}

async function createPersona(token, body = {}) {
  const res = await request(app)
    .post("/api/personas")
    .set(auth(token))
    .send({ name: "温柔学姐", shared: true, style: { summary: "轻声细语", catchphrases: ["没关系的"], stanceHint: "" }, ...body });
  expect(res.status).toBe(201);
  return res.body.persona;
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((block) => block.trim())
    .map((block) => ({ event: /event: (\w+)/.exec(block)[1], data: JSON.parse(/data: (.*)/.exec(block)[1]) }));
}

describe("人格的「音频」板块", () => {
  it("创建/更新带 voice；非法音色 id 400；null 清掉", async () => {
    const { token } = await createUser();
    const p = await createPersona(token, { voice: { voiceId: "zh_female_vv_uranus_bigtts", rate: -20, pitch: 2, instruct: "轻一点", expressive: false } });
    expect(p.voice).toEqual({ voiceId: "zh_female_vv_uranus_bigtts", rate: -20, pitch: 2, instruct: "轻一点", expressive: false });
    const got = await request(app).get(`/api/personas/${p._id}`);
    expect(got.body.persona.voice.voiceId).toBe("zh_female_vv_uranus_bigtts");

    const bad = await request(app).post("/api/personas").set(auth(token)).send({ name: "x", voice: { voiceId: "bad id with spaces" } });
    expect(bad.status).toBe(400);

    const cleared = await request(app).put(`/api/personas/${p._id}`).set(auth(token)).send({ voice: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.persona.voice).toBeNull();
    const untouched = await request(app).put(`/api/personas/${p._id}`).set(auth(token)).send({ name: "改名" });
    expect(untouched.body.persona.voice).toBeNull();
  });

  it("GET /api/tts/voices 给出目录与默认音色", async () => {
    process.env.COMPANION_TTS_VOICE = "zh_female_xiaohe_uranus_bigtts";
    const res = await request(app).get("/api/tts/voices");
    expect(res.status).toBe(200);
    expect(res.body.voices.length).toBeGreaterThan(10);
    expect(res.body.voices[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    expect(res.body.voices.every((v) => /uranus/.test(v.id))).toBe(true);
    expect(res.body.defaultVoiceId).toBe("zh_female_xiaohe_uranus_bigtts");
  });
});

describe("/api/companion/settings", () => {
  it("默认：没选人格/模型，嗓子是服务端默认", async () => {
    process.env.COMPANION_TTS_VOICE = "zh_female_xiaohe_uranus_bigtts";
    const { token } = await createUser();
    expect((await request(app).get("/api/companion/settings")).status).toBe(401);
    const res = await request(app).get("/api/companion/settings").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ personaId: null, modelId: null, voice: null });
    expect(res.body.persona).toBeNull();
    expect(res.body.model).toBeNull();
    expect(res.body.voice).toEqual({ voiceId: "zh_female_xiaohe_uranus_bigtts", rate: null, pitch: null, instruct: "", expressive: true });
  });

  it("选人格：公开可选、别人私有 403、付费未购 403(unpaid)、不存在 404；嗓子按 用户覆盖 > 人格 > 默认 逐字段合并", async () => {
    const me = await createUser("me");
    const other = await createUser("ot");
    const pub = await createPersona(other.token, { voice: { voiceId: "zh_female_vv_uranus_bigtts", rate: -15, instruct: "温柔一点" } });
    const priv = await createPersona(other.token, { name: "私有", shared: false });
    const paid = await createPersona(other.token, { name: "付费", price: 100 });

    const ok = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: pub._id });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.personaId).toBe(pub._id);
    expect(ok.body.persona).toMatchObject({ _id: pub._id, name: "温柔学姐" });
    expect(ok.body.persona.styleDescriptor).toBe("温柔学姐｜风格：轻声细语｜口头禅：没关系的");
    expect(ok.body.personaSource).toBe("user");
    expect(ok.body.voice).toEqual({ voiceId: "zh_female_vv_uranus_bigtts", rate: -15, pitch: null, instruct: "温柔一点", expressive: true });

    // 用户只改语速 → 音色/指令仍来自人格
    const override = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ voice: { rate: 20 } });
    expect(override.body.settings.voice).toEqual({ voiceId: "", rate: 20, pitch: null, instruct: "", expressive: true });
    expect(override.body.voice).toEqual({ voiceId: "zh_female_vv_uranus_bigtts", rate: 20, pitch: null, instruct: "温柔一点", expressive: true });

    const forbidden = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: priv._id });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.details).toEqual({ reason: "private" });
    const unpaid = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: paid._id });
    expect(unpaid.status).toBe(403);
    expect(unpaid.body.details).toEqual({ reason: "unpaid" });
    const missing = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: new mongoose.Types.ObjectId().toString() });
    expect(missing.status).toBe(404);
    // 失败的写入不影响已有选择
    const still = await request(app).get("/api/companion/settings").set(auth(me.token));
    expect(still.body.settings.personaId).toBe(pub._id);

    // 清掉
    const cleared = await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: null, voice: null });
    expect(cleared.body.settings).toEqual({ personaId: null, modelId: null, voice: null });
    expect(cleared.body.persona).toBeNull();
  });

  it("人格被取消分享 / 删除后静默回退，不报错", async () => {
    const me = await createUser("me2");
    const other = await createUser("ot2");
    const p = await createPersona(other.token);
    await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: p._id }).expect(200);
    await request(app).put(`/api/personas/${p._id}`).set(auth(other.token)).send({ shared: false }).expect(200);
    const hidden = await request(app).get("/api/companion/settings").set(auth(me.token));
    expect(hidden.body.settings.personaId).toBe(p._id);
    expect(hidden.body.persona).toBeNull();
    await request(app).delete(`/api/personas/${p._id}`).set(auth(other.token)).expect(200);
    const gone = await request(app).get("/api/companion/config").set(auth(me.token));
    expect(gone.status).toBe(200);
    expect(gone.body.persona).toBeNull();
  });

  it("config（首页看板娘 + App 客服）带出人格与 voiceSettings；游客只有默认", async () => {
    process.env.COMPANION_TTS_VOICE = "zh_female_xiaohe_uranus_bigtts";
    const me = await createUser("cf");
    const p = await createPersona(me.token, { voice: { voiceId: "zh_female_gujie_uranus_bigtts" } });
    await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: p._id }).expect(200);

    const guest = await request(app).get("/api/companion/config");
    expect(guest.body.persona).toBeNull();
    expect(guest.body.voice).toBe("zh_female_xiaohe_uranus_bigtts");
    expect(guest.body.voiceSettings.voiceId).toBe("zh_female_xiaohe_uranus_bigtts");

    const mine = await request(app).get("/api/companion/config").set(auth(me.token));
    expect(mine.body.persona.name).toBe("温柔学姐");
    expect(mine.body.voice).toBe("zh_female_gujie_uranus_bigtts");
    expect(mine.body.voiceSettings.voiceId).toBe("zh_female_gujie_uranus_bigtts");
    expect(mine.body.model).toBeNull();

    const support = await request(app).get("/api/support/config").set(auth(me.token));
    expect(support.body.persona.name).toBe("温柔学姐");
    expect(support.body.voiceSettings.voiceId).toBe("zh_female_gujie_uranus_bigtts");
    expect(support.body.voice).toBe("zh_female_gujie_uranus_bigtts");
  });

  it("聊天：装了人格 → 系统提示词多一段人设、每句 tts.instruct 前面带人设语调；没装 → 提示词里没有人设段", async () => {
    const me = await createUser("ch");
    const bare = await request(app).post("/api/companion/chat").set(auth(me.token)).send({ messages: [{ role: "user", content: "你好" }] });
    expect(bare.status).toBe(200);
    expect(mockLastMessages[0].content).not.toContain("【人设】");
    let events = parseSse(bare.text);
    expect(events.find((e) => e.event === "sentence").data.tts.instruct).toBe("用开心明快的语气");

    const p = await createPersona(me.token, { name: "冷淡前辈", voice: { instruct: "冷淡、少起伏" } });
    await request(app).put("/api/companion/settings").set(auth(me.token)).send({ personaId: p._id }).expect(200);
    const withPersona = await request(app).post("/api/companion/chat").set(auth(me.token)).send({ messages: [{ role: "user", content: "你好" }] });
    expect(withPersona.status).toBe(200);
    const system = mockLastMessages[0].content;
    expect(system).toContain("【人设】");
    expect(system).toContain("冷淡前辈");
    expect(system).toContain("风格：轻声细语");
    events = parseSse(withPersona.text);
    expect(events.find((e) => e.event === "sentence").data.tts.instruct).toBe("冷淡、少起伏；用开心明快的语气");

    // 客服链路同样注入，且规则段仍在
    const sup = await request(app).post("/api/support/chat").set(auth(me.token)).send({ messages: [{ role: "user", content: "怎么退款" }] });
    expect(sup.status).toBe(200);
    expect(mockLastMessages[0].content).toContain("【人设】");
    expect(mockLastMessages[0].content).toContain("【禁止承诺】");
  });
});
