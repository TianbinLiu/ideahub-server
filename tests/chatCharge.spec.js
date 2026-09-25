/**
 * 四条聊天链路**真的扣钱**（而不是「扣了又退」）。
 *
 * ★★ 为什么必须有这一份：#78 把陪聊/客服/试聊接进钱包，靠的是每条链路里
 *   `let produced = false` + `finish` 回调里那一行 `produced = Boolean(text)`
 *   + 事后 `if (!produced) refundUnaccepted(...)`。
 *   而 #76 在**同一个 finish 回调**上加了输出侧守卫 —— 两边合并时若取错一侧，
 *   会得到一段语法完全正确、看起来就是原作者写法的代码，只是 `produced` 永远 false：
 *   **每轮扣 400 再退 400，陪聊静默回到不计费**。
 *   合并前唯一相关的断言是 billing.spec 里那条「路由引到了 billing」的登记册测试，
 *   它只 grep 源码里有没有 require —— 上面那三处赋值全删掉它照样绿（实测）。
 *   本文件把「扣了就不该退」钉成断言：账本里必须是 `ark_spend` 一条，
 *   而不是 `ark_spend` + `ark_refund` 一对。
 *
 * ★ 反向用例（上游一个字都没吐 ⇒ 必须退）同样在这里：
 *   只断言「没有退款」的话，把 refundUnaccepted 整段删掉也是绿的。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

// 上游脚本：默认吐两句；把 emptyStream 打开就一个字都不吐（模拟敏感词/限流/上游挂了）
const mockState = { emptyStream: false };
jest.mock("../src/services/aiClient", () => {
  const actual = jest.requireActual("../src/services/aiClient");
  return {
    ...actual,
    hasAiKey: () => true,
    aiComplete: async () => ({ text: '```json\n{"subject":"x","summary":"x","category":"other"}\n```', model: "mock" }),
    aiChatStream: async function* () {
      if (mockState.emptyStream) return;
      for (const c of ["[neutral][face:normal][action:explain] 好呀，", "我们接着聊。"]) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield c;
      }
    },
  };
});

let mongod;
let app;
let User;
let TokenLedger;
let signToken;
let wallet;
let CHAT;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  ({ signToken } = require("../src/utils/jwt"));
  wallet = require("../src/services/tokenWallet.service");
  CHAT = require("../src/config/tokens").priceOf("chat", {});
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  mockState.emptyStream = false;
});

async function makeUser() {
  const rand = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `cc_${rand}`, email: `${rand}@test.local`, role: "user", passwordHash: "x" });
  // 钱包是懒初始化的（第一次扣费时才建）。先建好，"before" 才量得到免费档那笔月度额度。
  await wallet.ensureWallet(user._id);
  return { user, token: signToken(user) };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * 这个人的账本（按写入顺序），只留 reason/delta 两列。
 * ★ 滤掉 grant / cycle_reset：那两条是「印钱」（首次发放与月度刷新），
 *   与这一轮对话花了多少钱无关，留着只会把断言写成一串与本意无关的行。
 */
const MINTED = new Set(["grant", "cycle_reset"]);
async function rows(userId) {
  const found = await TokenLedger.find({ user: userId }).sort({ createdAt: 1, _id: 1 }).lean();
  return found.filter((r) => !MINTED.has(r.reason)).map((r) => ({ reason: r.reason, delta: r.delta }));
}

/**
 * 账本「不再变化」之后再读。
 *
 * ★ 陪聊与试聊的退款发生在 `res.end()` **之后**（SSE 自己收尾，退款是收尾后的一句 await），
 *   所以 supertest 的 await 一返回就断言是在和退款赛跑 —— 而这场赛跑输赢都是错的：
 *   「该退没退」测不出来，「不该退却退了」也测不出来。这里等到连续两次读数相同为止。
 */
async function ledger(userId) {
  let last = JSON.stringify(await rows(userId));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const now = JSON.stringify(await rows(userId));
    if (now === last) return JSON.parse(now);
    last = now;
  }
  return JSON.parse(last);
}

async function balance(userId) {
  const u = await User.findById(userId).select("tokenWallet").lean();
  return u.tokenWallet.plan + u.tokenWallet.addon;
}

/** 四条链路，每条都是「一次成功的对话」 */
const PATHS = [
  {
    name: "陪聊 · 旧写法（客户端自带历史）",
    run: (token) => request(app).post("/api/companion/chat").set(auth(token)).send({ messages: [{ role: "user", content: "你好呀" }] }),
  },
  {
    name: "陪聊 · 按会话",
    run: (token) => request(app).post("/api/companion/chat").set(auth(token)).send({ message: "你好呀" }),
  },
  {
    name: "客服",
    run: (token) => request(app).post("/api/support/chat").set(auth(token)).send({ messages: [{ role: "user", content: "取回怎么用" }] }),
  },
  {
    name: "人格试聊",
    run: (token) =>
      request(app)
        .post("/api/personas/preview-chat")
        .set(auth(token))
        .send({ draft: { name: "阿冲", style: { summary: "句子短", tone: "松弛", greeting: "来了老铁" } }, messages: [{ role: "user", content: "在吗" }] }),
  },
];

describe("聊天链路的扣费：成功一轮 = 账本一条 ark_spend，没有退款", () => {
  for (const p of PATHS) {
    it(`${p.name}：扣 ${400} 且**不退**`, async () => {
      const { user, token } = await makeUser();
      const before = await balance(user._id);

      const res = await p.run(token);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/event: done/);

      // ★ 这三条断言各自都能单独抓住「produced 永远 false」：
      //   ① 账本只有扣款一条；② 没有任何退款；③ 余额真的少了 400。
      expect(await ledger(user._id)).toEqual([{ reason: "ark_spend", delta: -CHAT }]);
      expect(await balance(user._id)).toBe(before - CHAT);
    });
  }
});

describe("聊天链路的退款：上游一个字都没吐 = 扣了要退回来", () => {
  for (const p of PATHS) {
    it(`${p.name}：ark_spend + ark_refund 成对，余额归位`, async () => {
      const { user, token } = await makeUser();
      const before = await balance(user._id);
      mockState.emptyStream = true;

      const res = await p.run(token);
      expect(res.status).toBe(200);

      expect(await ledger(user._id)).toEqual([
        { reason: "ark_spend", delta: -CHAT },
        { reason: "ark_refund", delta: CHAT },
      ]);
      expect(await balance(user._id)).toBe(before);
    });
  }
});

describe("危机那一轮是 0 token（#76 对外的承诺）", () => {
  // ★ 顺序守卫：危机 early-return 必须排在 preAuthorize **之前**。反过来的话这一轮
  //   扣了 400 既不退也不结算 —— 而两份公示页都写着「触发安全提示不消耗 token」。
  const CRISIS = "我想吞一整瓶安眠药结束这一切";
  const CASES = [
    ["陪聊 · 旧写法", () => ({ url: "/api/companion/chat", body: { messages: [{ role: "user", content: CRISIS }] } })],
    ["陪聊 · 按会话", () => ({ url: "/api/companion/chat", body: { message: CRISIS } })],
    ["客服", () => ({ url: "/api/support/chat", body: { messages: [{ role: "user", content: CRISIS }] } })],
    [
      "人格试聊",
      () => ({
        url: "/api/personas/preview-chat",
        body: { draft: { name: "阿冲", style: { summary: "句子短" } }, messages: [{ role: "user", content: CRISIS }] },
      }),
    ],
  ];

  for (const [name, mk] of CASES) {
    it(`${name}：账本一条都不写，余额分文未动`, async () => {
      const { user, token } = await makeUser();
      const before = await balance(user._id);
      const { url, body } = mk();

      const res = await request(app).post(url).set(auth(token)).send(body);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/"safety":true/);

      expect(await ledger(user._id)).toEqual([]);
      expect(await balance(user._id)).toBe(before);
    });
  }
});
