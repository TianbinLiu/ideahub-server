/**
 * 剪辑页配音免费 + 限量（2026-10-08，config/tokens.NARRATION_FREE_DAILY_CHARS）。
 *
 * ★ 要钉住的事：
 *   · 带 `purpose: "cut-narration"` 的一句**不扣钱**（余额不动、不占每日用量上限），但落一笔 narration_free（costTokens 照价）；
 *   · 每个账号每个 UTC 日最多这么多字，**并发也冲不破**；用完是 429、不转成扣钱、不调上游；
 *   · 上游没出声 / 中途断开，占掉的额度还回去；
 *   · 只给「只念字」的形状（混音 / 表现力 / 语调指令 / 情绪一律拒），认不出的 purpose 整句拒；
 *   · 不带 purpose 的照旧按字扣（客服 / 看板娘 / 试听）；
 *   · /api/tts/voices 带能力位（App 只有看见它才说「免费」）；删号把计数器一起带走。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let fetchSpy;
let mongod;
let app;
let User;
let TokenLedger;
let NarrationFreeUsage;
let wallet;
let tokens;
let narrationFree;
let signToken;

beforeAll(async () => {
  fetchSpy = jest.spyOn(global, "fetch");
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.TTS_API_KEY = "test-tts-key";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  NarrationFreeUsage = require("../src/models/NarrationFreeUsage");
  wallet = require("../src/services/tokenWallet.service");
  tokens = require("../src/config/tokens");
  narrationFree = require("../src/services/narrationFree.service");
  ({ signToken } = require("../src/utils/jwt"));
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  // ★ dropDatabase 连索引一起删，而 Model.init() 只跑一次 —— 不重建的话唯一索引没了，「并发冲不破」那条就测了个空
  await NarrationFreeUsage.createIndexes();
  fetchSpy.mockReset();
});

const N = "cut-narration";
const LIMIT = () => tokens.NARRATION_FREE_DAILY_CHARS;

async function makeUser() {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const u = await User.create({ username: `nf_${rand}`, email: `${rand}@test.local`, role: "user", passwordHash: "x" });
  return { user: u, token: signToken(u) };
}

async function balance(userId) {
  const w = await wallet.getWallet(userId);
  return w.plan + w.addon;
}

async function usedToday(userId) {
  const row = await NarrationFreeUsage.findOne({ userId, day: wallet.currentDay() }).lean();
  return row ? row.chars : 0;
}

/** 豆包 TTS 的 SSE：一帧音频 + 结束帧 */
function ttsOk() {
  const audio = Buffer.from("fake-mp3").toString("base64");
  return { status: 200, text: async () => `data: ${JSON.stringify({ data: audio })}\n\ndata: ${JSON.stringify({ code: 20000000, message: "OK" })}\n\n` };
}
function ttsFail(code = 45000030) {
  return { status: 200, text: async () => `data: ${JSON.stringify({ code, message: "resource not activated" })}\n\n` };
}

const say = (token, body) => request(app).post("/api/tts").set("Authorization", `Bearer ${token}`).send(body);

describe("GET /api/tts/voices 的能力位", () => {
  it("带 narrationFree.dailyChars —— 数字就是服务端那一处", async () => {
    const res = await request(app).get("/api/tts/voices");
    expect(res.status).toBe(200);
    expect(res.body.narrationFree).toEqual({ dailyChars: LIMIT() });
  });
});

describe("剪辑页旁白：免费", () => {
  it("一句旁白 → 200 出声；余额不动、没有 ark_spend；落一笔 narration_free（delta 0、costTokens 按字照价）；额度记上", async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    fetchSpy.mockResolvedValueOnce(ttsOk());
    const text = "清晨的街道还没醒"; // 8 字
    const res = await say(token, { text, voice: "zh_female_zhixingnv_uranus_bigtts", rate: 12, purpose: N });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/mpeg/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 语速照常送上去（旁白念不完时 App 会提一档）
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).req_params.audio_params.speech_rate).toBe(12);

    expect(await balance(user._id)).toBe(before);
    expect(await TokenLedger.countDocuments({ user: user._id, reason: "ark_spend" })).toBe(0);
    const rows = await TokenLedger.find({ user: user._id, reason: "narration_free" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(0);
    expect(rows[0].costTokens).toBe(tokens.priceOf("tts", { text }));
    expect(rows[0].costTokens).toBe(8 * tokens.TTS_TOKENS_PER_CHAR);
    expect(rows[0].memo).toMatch(/^tts zh_female_zhixingnv_uranus_bigtts narration$/);
    expect(await usedToday(user._id)).toBe(8);
    // 不是用户花的钱：不占每日用量上限
    expect(await wallet.spentToday(user._id)).toBe(0);
  });

  it("不带 purpose 的照旧按字扣（客服 / 看板娘 / 试听），也不动旁白额度", async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    fetchSpy.mockResolvedValueOnce(ttsOk());
    expect((await say(token, { text: "你好世界" })).status).toBe(200);
    expect(await balance(user._id)).toBe(before - 4 * tokens.TTS_TOKENS_PER_CHAR);
    expect(await usedToday(user._id)).toBe(0);
    expect(await TokenLedger.countDocuments({ user: user._id, reason: "narration_free" })).toBe(0);
  });

  it("额度按截断后的字数算（送去合成的是 300 字，就记 300）", async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockResolvedValueOnce(ttsOk());
    expect((await say(token, { text: "啊".repeat(5000), purpose: N })).status).toBe(200);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).req_params.text).toHaveLength(300);
    expect(await usedToday(user._id)).toBe(300);
  });
});

describe("剪辑页旁白：限量", () => {
  it("刚好用到上限能过；再多一个字 → 429 NARRATION_DAILY_LIMIT，不调上游、不扣钱、额度不动", async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    await NarrationFreeUsage.create({ userId: user._id, day: wallet.currentDay(), chars: LIMIT() - 3 });

    const over = await say(token, { text: "四个字啊", purpose: N });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("NARRATION_DAILY_LIMIT");
    expect(over.body.limit).toBe(LIMIT());
    expect(over.body.used).toBe(LIMIT() - 3);
    expect(over.body.need).toBe(4);
    // App 认 details（throwHttp / request 只搬 details）；还剩 3 字时说的是「放不下」，不是「用完了」
    expect(over.body.details).toEqual({ limit: LIMIT(), used: LIMIT() - 3, need: 4 });
    expect(over.body.message).toMatch(/还剩 3 字/);
    expect(over.body.message).not.toMatch(/用完了/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usedToday(user._id)).toBe(LIMIT() - 3);

    fetchSpy.mockResolvedValueOnce(ttsOk());
    expect((await say(token, { text: "三个字", purpose: N })).status).toBe(200);
    expect(await usedToday(user._id)).toBe(LIMIT());

    const again = await say(token, { text: "一", purpose: N });
    expect(again.status).toBe(429);
    expect(again.body.message).toMatch(/用完了/);
    expect(again.body.details).toEqual({ limit: LIMIT(), used: LIMIT(), need: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // ★ 用完不转成扣钱：余额一分没动
    expect(await balance(user._id)).toBe(before);
  });

  it("★ 并发冲不破上限：一起打进来的几发，加起来不超过当天的额度", async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockImplementation(async () => ttsOk());
    const line = "字".repeat(300);
    const k = Math.ceil(LIMIT() / 300) + 3;
    const results = await Promise.all(Array.from({ length: k }, () => say(token, { text: line, purpose: N })));
    const ok = results.filter((r) => r.status === 200).length;
    const capped = results.filter((r) => r.status === 429 && r.body.code === "NARRATION_DAILY_LIMIT").length;
    expect(ok).toBe(Math.floor(LIMIT() / 300));
    expect(ok + capped).toBe(k);
    expect(await usedToday(user._id)).toBe(ok * 300);
    expect(await usedToday(user._id)).toBeLessThanOrEqual(LIMIT());
    expect(fetchSpy).toHaveBeenCalledTimes(ok);
    expect(await TokenLedger.countDocuments({ user: user._id, reason: "narration_free" })).toBe(ok);
  });

  // ★ 上一条走 HTTP，中间件把几发错开了，当天第一批并发「都去插那一行、只有一发插成」的那一下撞不上（跑十几遍都绿）。
  //   这里直接并发打 reserve：撞唯一索引的那几发余量其实够，不许被当成「用完了」。
  it("★ 当天第一批并发直接打 reserve：余量够就都占成；余量不够时占成的合计正好是放得下的那几发", async () => {
    for (let trial = 0; trial < 10; trial += 1) {
      const { user } = await makeUser();
      const small = await Promise.all(Array.from({ length: 5 }, () => narrationFree.reserve(user._id, 10)));
      expect(small.filter((r) => r.ok)).toHaveLength(5);
      expect(await usedToday(user._id)).toBe(50);
    }
    for (let trial = 0; trial < 5; trial += 1) {
      const { user } = await makeUser();
      const k = Math.ceil(LIMIT() / 300) + 3;
      const res = await Promise.all(Array.from({ length: k }, () => narrationFree.reserve(user._id, 300)));
      const granted = res.filter((r) => r.ok).length;
      expect(granted).toBe(Math.floor(LIMIT() / 300));
      expect(await usedToday(user._id)).toBe(granted * 300);
    }
  });

  it("★ 拒了之后报数时别的句子刚好把额度还回来（余量又够了）→ 再占一次，不报一句自相矛盾的「放不下」", async () => {
    const { user } = await makeUser();
    const day = wallet.currentDay();
    await NarrationFreeUsage.create({ userId: user._id, day, chars: LIMIT() - 5 });
    // 在拒绝之后、读余量那一下之前插进来一次 release（同一个人别的句子没出声，还了 300）
    const realFindOne = NarrationFreeUsage.findOne.bind(NarrationFreeUsage);
    let injected = false;
    const spy = jest.spyOn(NarrationFreeUsage, "findOne").mockImplementation((...args) => {
      if (!injected) {
        injected = true;
        return {
          select: () => ({
            lean: async () => {
              await NarrationFreeUsage.updateOne({ userId: user._id, day }, { $inc: { chars: -300 } });
              return realFindOne(...args).select("chars").lean();
            },
          }),
        };
      }
      return realFindOne(...args);
    });
    try {
      const r = await narrationFree.reserve(user._id, 10);
      expect(injected).toBe(true);
      expect(r).toMatchObject({ ok: true, chars: 10, used: LIMIT() - 5 - 300 + 10 });
    } finally {
      spy.mockRestore();
    }
  });

  it("额度按 UTC 日算：昨天用满不影响今天", async () => {
    const { user } = await makeUser();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const a = await narrationFree.reserve(user._id, LIMIT(), yesterday);
    expect(a.ok).toBe(true);
    expect((await narrationFree.reserve(user._id, 1, yesterday)).ok).toBe(false);
    const b = await narrationFree.reserve(user._id, 10);
    expect(b).toMatchObject({ ok: true, chars: 10, used: 10, limit: LIMIT() });
  });

  it("每个账号各算各的", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await NarrationFreeUsage.create({ userId: a.user._id, day: wallet.currentDay(), chars: LIMIT() });
    fetchSpy.mockResolvedValueOnce(ttsOk());
    expect((await say(a.token, { text: "你好", purpose: N })).status).toBe(429);
    expect((await say(b.token, { text: "你好", purpose: N })).status).toBe(200);
  });
});

describe("剪辑页旁白：没出声就把额度还回去", () => {
  it("上游一帧音频都没给 → 502；额度还回去、不落 narration_free、余额不动", async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    fetchSpy.mockResolvedValueOnce(ttsFail());
    const res = await say(token, { text: "你好世界", purpose: N });
    expect(res.status).toBe(502);
    expect(await usedToday(user._id)).toBe(0);
    expect(await TokenLedger.countDocuments({ user: user._id, reason: "narration_free" })).toBe(0);
    expect(await balance(user._id)).toBe(before);
  });

  it("连不上上游 → 504；额度还回去", async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    const res = await say(token, { text: "你好世界", purpose: N });
    expect(res.status).toBe(504);
    expect(await usedToday(user._id)).toBe(0);
  });

  it("读回包时中途断开（抛异常）→ 额度照样还回去", async () => {
    const { user, token } = await makeUser();
    fetchSpy.mockResolvedValueOnce({ status: 200, text: async () => { throw new Error("socket hang up"); } });
    const res = await say(token, { text: "你好世界", purpose: N });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await usedToday(user._id)).toBe(0);
  });
});

describe("剪辑页旁白：只收「只念字」的形状", () => {
  const F = "zh_female_gaolengyujie_moon_bigtts";
  it.each([
    ["混音", { mix: [{ voiceId: F, weight: 1 }] }],
    ["表现力", { expressive: true }],
    ["语调指令", { instruct: "用更冷静的语气" }],
    ["情绪", { emotion: "happy" }],
  ])("带%s → 400 NARRATION_SHAPE，不调上游、不占额度、不扣钱", async (_name, extra) => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    const res = await say(token, { text: "你好", purpose: N, ...extra });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NARRATION_SHAPE");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await usedToday(user._id)).toBe(0);
    expect(await balance(user._id)).toBe(before);
  });

  it("空 mix 不算混音（与计费那条同一个判据）", async () => {
    const { token } = await makeUser();
    fetchSpy.mockResolvedValueOnce(ttsOk());
    expect((await say(token, { text: "你好", purpose: N, mix: [] })).status).toBe(200);
  });

  it("认不出的 purpose → 400 TTS_PURPOSE（不当成「没带」去悄悄扣钱）", async () => {
    const { user, token } = await makeUser();
    const before = await balance(user._id);
    const res = await say(token, { text: "你好", purpose: "something-else" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TTS_PURPOSE");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(user._id)).toBe(before);
  });
});

describe("账本 / 删号", () => {
  it("narration_free 在账本 enum 里，不进 SPEND_REASONS（不占当日用量）", () => {
    expect(TokenLedger.TOKEN_REASONS).toContain("narration_free");
    expect(wallet.SPEND_REASONS).not.toContain("narration_free");
  });

  it("删号把计数器一起带走", async () => {
    const { user } = await makeUser();
    await NarrationFreeUsage.create({ userId: user._id, day: wallet.currentDay(), chars: 12 });
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const removed = await purgeUserCascade(user._id);
    expect(removed.narrationFreeUsage).toBe(1);
    expect(await NarrationFreeUsage.countDocuments({ userId: user._id })).toBe(0);
  });
});
