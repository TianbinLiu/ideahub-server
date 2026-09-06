/**
 * 创作中心 · 人物人格向导（2026-09-05）：/analyze → /generate（basics + 问卷 + 分析 / only 重生成）→ /preview-chat（SSE）→ 创建带新字段 → 列表数据库分页。
 * 上游 LLM 用 jest.mock 换成固定脚本：analyze 与 generate 按提示词里的角色名分流。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

const ANALYSIS = {
  catchphrases: ["害，就这？", "冲了冲了"],
  habits: { sentenceLength: "短", punctuation: "爱用波浪号", emoji: "偶尔", particles: "嘛、啦", tone: "松弛" },
  stances: ["先做再说"],
  topics: ["游戏", "咖啡"],
  avoids: ["政治"],
  samples: ["我电话 13812345678 你记一下", "冲了冲了～"],
};
const DRAFT = {
  name: "阿冲",
  description: "松弛感十足的开黑搭子",
  coverEmoji: "🎮",
  tags: ["搭子", "松弛"],
  summary: "句子短，爱用波浪号，被夸会嘴硬。",
  catchphrases: ["害，就这？", "冲了冲了"],
  stanceHint: "先做再说",
  tone: "松弛，偶尔嘴硬",
  addressUser: "老铁",
  greeting: "来了老铁～今天开不开黑？",
  examples: [
    { user: "在吗", reply: "在呢在呢～说" },
    { user: "你好厉害", reply: "害，就这？基操啦" },
    { user: "我今天好累", reply: "先躺会儿嘛，游戏又跑不了" },
    { user: "你会做饭吗", reply: "不会，但我会点外卖，邮箱 a@b.com 发我地址" },
  ],
  boundaries: ["不聊政治"],
};

jest.mock("../src/services/aiClient", () => {
  const actual = jest.requireActual("../src/services/aiClient");
  return {
    ...actual,
    hasAiKey: () => true,
    aiComplete: async (prompt) => {
      global.__lastPrompt = prompt;
      if (prompt.includes("说话风格分析师")) return { text: "```json\n" + JSON.stringify(ANALYSIS) + "\n```", model: "mock" };
      // only 模式：只回新的开场白（其余字段照抄草稿由服务器合并）
      if (prompt.includes("只重新生成这些字段")) return { text: JSON.stringify({ name: "被润色的名字", greeting: "嘿老铁，新开场白！" }), model: "mock" };
      return { text: JSON.stringify(DRAFT), model: "mock" };
    },
    aiChatStream: async function* () {
      const chunks = ["[happy][face:happy][action:wave] 来了老铁～", "[neutral][face:normal][action:explain] 今天开不开黑？"];
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, 15));
        yield c;
      }
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

async function createUser(prefix = "pw") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe("POST /api/personas/analyze", () => {
  it("未登录 401；空素材 400；正常 → 归一化的分析，模型输出里的手机号被抹掉", async () => {
    const { token } = await createUser();
    expect((await request(app).post("/api/personas/analyze").send({ materials: [{ text: "x" }] })).status).toBe(401);
    expect((await request(app).post("/api/personas/analyze").set(auth(token)).send({ materials: [] })).status).toBe(400);
    const res = await request(app)
      .post("/api/personas/analyze")
      .set(auth(token))
      .send({ materials: [{ kind: "chat", text: "阿冲: 冲了冲了～\n我: 等我五分钟\n阿冲: 害，就这？" }], speaker: "阿冲" });
    expect(res.status).toBe(200);
    expect(res.body.analysis.catchphrases).toEqual(["害，就这？", "冲了冲了"]);
    expect(res.body.analysis.habits.tone).toBe("松弛");
    expect(res.body.analysis.samples[0]).toBe("我电话 *** 你记一下");
    expect(res.body.sampledChars).toBeGreaterThan(10);
    expect(global.__lastPrompt).toMatch(/「阿冲」/);
  });
});

describe("POST /api/personas/generate（向导扩参）", () => {
  it("老入口：chatText < 20 字 400；什么都不给 400；only 没带 draft 400", async () => {
    const { token } = await createUser();
    expect((await request(app).post("/api/personas/generate").set(auth(token)).send({ chatText: "太短" })).status).toBe(400);
    expect((await request(app).post("/api/personas/generate").set(auth(token)).send({})).status).toBe(400);
    expect((await request(app).post("/api/personas/generate").set(auth(token)).send({ basics: { name: "x" }, only: ["greeting"] })).status).toBe(400);
  });

  it("basics + 问卷 + 分析 → 草稿带 tone / greeting / examples / boundaries；用户填的名字优先；示例里的邮箱被抹掉", async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post("/api/personas/generate")
      .set(auth(token))
      .send({
        basics: { name: "小冲", role: "陪聊", relation: "开黑搭子", intro: "松弛的搭子" },
        questionnaire: { extroversion: 20, humor: 80, language: "zh", taboos: ["政治"] },
        analysis: ANALYSIS,
      });
    expect(res.status).toBe(200);
    const d = res.body.draft;
    expect(d.name).toBe("小冲");
    expect(d.style.tone).toBe("松弛，偶尔嘴硬");
    expect(d.style.greeting).toBe("来了老铁～今天开不开黑？");
    expect(d.style.addressUser).toBe("老铁");
    expect(d.style.examples).toHaveLength(4);
    expect(d.style.examples[3].reply).toBe("不会，但我会点外卖，邮箱 *** 发我地址");
    expect(d.style.boundaries).toEqual(["不聊政治"]);
    expect(d.style.catchphrases).toEqual(["害，就这？", "冲了冲了"]);
    expect(global.__lastPrompt).toMatch(/外向 ↔ 内向.*：20/);
    expect(global.__lastPrompt).toMatch(/禁忌话题：政治/);
  });

  it("only=['greeting'] + draft：只换开场白，名字等其余字段照抄草稿", async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post("/api/personas/generate")
      .set(auth(token))
      .send({ basics: { name: "小冲" }, only: ["greeting"], draft: { name: "小冲", description: "旧简介", coverEmoji: "🎮", tags: ["旧"], style: { summary: "旧总结", greeting: "旧开场白" } } });
    expect(res.status).toBe(200);
    expect(res.body.draft.name).toBe("小冲");
    expect(res.body.draft.description).toBe("旧简介");
    expect(res.body.draft.style.summary).toBe("旧总结");
    expect(res.body.draft.style.greeting).toBe("嘿老铁，新开场白！");
  });
});

describe("POST /api/personas/preview-chat", () => {
  it("最后一条不是 user → 400；正常 → SSE sentence / done，人设与示例进了提示词", async () => {
    const { token } = await createUser();
    const draft = { name: "阿冲", style: { summary: "句子短", tone: "松弛", greeting: "来了老铁", examples: DRAFT.examples } };
    const bad = await request(app).post("/api/personas/preview-chat").set(auth(token)).send({ draft, messages: [{ role: "assistant", content: "hi" }] });
    expect(bad.status).toBe(400);
    const res = await request(app).post("/api/personas/preview-chat").set(auth(token)).send({ draft, messages: [{ role: "user", content: "在吗" }] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/event: sentence/);
    expect(res.text).toMatch(/"face":"happy"/);
    expect(res.text).toMatch(/event: done/);
  });
});

describe("创建 / 列表", () => {
  it("createPersona 收下新字段并原样序列化；styleDescriptor 拼进语气 / 称呼 / 边界", async () => {
    const { token } = await createUser();
    const res = await request(app)
      .post("/api/personas")
      .set(auth(token))
      .send({ name: "阿冲", description: "搭子", shared: true, style: { summary: "句子短", catchphrases: ["冲了"], tone: "松弛", addressUser: "老铁", greeting: "来了", examples: DRAFT.examples.slice(0, 2), boundaries: ["不聊政治"] } });
    expect(res.status).toBe(201);
    const p = res.body.persona;
    expect(p.style.tone).toBe("松弛");
    expect(p.style.greeting).toBe("来了");
    expect(p.style.examples).toHaveLength(2);
    expect(p.style.boundaries).toEqual(["不聊政治"]);
    expect(p.styleDescriptor).toBe("阿冲｜风格：句子短｜语气：松弛｜口头禅：冲了｜称呼用户：老铁｜边界：不聊政治");
    expect(p.takenDown).toBe(false);
  });

  it("列表在数据库里搜索 / 排序 / 分页；下架的不进市场", async () => {
    const { token } = await createUser();
    const Persona = require("../src/models/Persona");
    const mk = (name, extra = {}) => request(app).post("/api/personas").set(auth(token)).send({ name, description: "d", shared: true, ...extra });
    const a = (await mk("咖啡师小北")).body.persona;
    await mk("游戏搭子阿冲");
    await mk("私有的", { shared: false });
    const down = (await mk("要下架的")).body.persona;
    await Persona.updateOne({ _id: down._id }, { $set: { takenDown: true } });
    await Persona.updateOne({ _id: a._id }, { $set: { "stats.downloadCount": 5 } });

    const all = await request(app).get("/api/personas?limit=2&page=1");
    expect(all.body.total).toBeGreaterThanOrEqual(2);
    expect(all.body.personas).toHaveLength(2);
    expect(all.body.personas.map((x) => x.name)).not.toContain("要下架的");
    expect(all.body.personas.map((x) => x.name)).not.toContain("私有的");
    const q = await request(app).get("/api/personas").query({ q: "咖啡" });
    expect(q.body.personas.map((x) => x.name)).toEqual(["咖啡师小北"]);
    const hot = await request(app).get("/api/personas?sort=hot&limit=1");
    expect(hot.body.personas[0].name).toBe("咖啡师小北");
  });
});
