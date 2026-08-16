// tests/tokenWallet.spec.js
// 覆盖：AI token 钱包（服务端记账）与 /api/ark 的扣费闸门。
//
// ★ 这套用例盯的是三条【做错了不会报错、只会悄悄多扣或白送】的不变量
//   （见 services/tokenWallet.service.js 的文件头）：
//     W1 并发不超付 —— 条件原子更新，不是读-改-写
//     W2 上游没受理就必须退 —— 否则"报错一次扣一次钱"
//     W3 月度刷新只发生在跨月的第一次触达 —— 否则并发下反复发额度
//   外加一条产品规则：**先扣 plan 再扣 addon**（plan 跨月作废，先花掉才不亏用户）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;
let TokenLedger;
let walletSvc;

const FREE = 300_000;
/** 默认档（Seedream 4.0，0.20 元/张 ÷ 15 元/M）单图。
 *  ★ 出图**按 model 计价**，所以这个常量只对下面那条用 4.0 的用例成立，不是"一张图的价"。 */
const IMAGE = 13_333;
const CHAT = 400;

let mongoUri;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  mongoUri = mongod.getUri();
  process.env.MONGO_URI = mongoUri;
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  walletSvc = require("../src/services/tokenWallet.service");
});

afterAll(async () => {
  delete process.env.ARK_API_KEY; // 别把 key 漏给同一进程里后跑的用例（--runInBand）
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `tw${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

/** 让上游"方舟"按剧本回应，测试里不真的出网 */
function mockArk(status, body = { ok: true }) {
  process.env.ARK_API_KEY = "test-key";
  return jest.spyOn(global, "fetch").mockImplementation(async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  }));
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ARK_API_KEY;
});

async function balanceOf(userId) {
  const u = await User.findById(userId).select("tokenWallet").lean();
  return u?.tokenWallet ? u.tokenWallet.plan + u.tokenWallet.addon : null;
}

describe("钱包初始化与月度刷新（W3）", () => {
  test("新账号没有 tokenWallet 字段；第一次读余额才发放，并落一条 grant 流水", async () => {
    const { token, userId } = await registerUser();
    // ★ 刻意不给 schema default：有没有这个字段就是"要不要初始化"的判据本身
    expect(await balanceOf(userId)).toBeNull();

    const res = await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    expect(res.body.wallet).toMatchObject({ plan: FREE, addon: 0, planId: "free" });

    const rows = await TokenLedger.find({ user: userId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "grant", delta: FREE, balanceAfter: FREE });
  });

  test("并发首次触达只发一次额度（不会因为两个请求同时来就发两份）", async () => {
    const { token, userId } = await registerUser();
    await Promise.all(Array.from({ length: 8 }, () => request(app).get("/api/me/wallet").set(auth(token))));
    expect(await balanceOf(userId)).toBe(FREE);
    expect(await TokenLedger.countDocuments({ user: userId, reason: "grant" })).toBe(1);
  });

  test("跨月：plan 归位到当月额度、addon 不动；同一个月内不重复刷新", async () => {
    const { token, userId } = await registerUser();
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    await walletSvc.credit(userId, 50_000, "recharge", "测试直充");
    await walletSvc.debit(userId, 100_000, "测试消耗");
    // 手动把周期拨回上个月，模拟"上次使用是上个月"
    await User.updateOne({ _id: userId }, { $set: { "tokenWallet.cycle": "2000-01" } });

    const w = await walletSvc.getWallet(userId);
    expect(w.plan).toBe(FREE); // 归位，未用完的作废
    expect(w.addon).toBe(50_000); // addon 不受月度刷新影响

    const again = await walletSvc.getWallet(userId);
    expect(again.plan).toBe(FREE);
    // 同月内再读不会再记一条 cycle_reset
    expect(await TokenLedger.countDocuments({ user: userId, reason: "cycle_reset" })).toBe(1);
  });
});

describe("扣费口径：先扣 plan 再扣 addon（W1）", () => {
  test("plan 够时只动 plan", async () => {
    const { userId } = await registerUser();
    await walletSvc.getWallet(userId);
    await walletSvc.credit(userId, 10_000, "recharge");
    const w = await walletSvc.debit(userId, 1_000, "测试");
    expect(w).toMatchObject({ plan: FREE - 1_000, addon: 10_000 });
  });

  test("plan 不够时先掏空 plan 再动 addon", async () => {
    const { userId } = await registerUser();
    await walletSvc.getWallet(userId);
    await walletSvc.credit(userId, 100_000, "recharge");
    const w = await walletSvc.debit(userId, FREE + 25_000, "测试");
    expect(w).toMatchObject({ plan: 0, addon: 75_000 });
  });

  test("余额不足：一分不扣、返回 null（不是扣到负数）", async () => {
    const { userId } = await registerUser();
    await walletSvc.getWallet(userId);
    expect(await walletSvc.debit(userId, FREE + 1, "测试")).toBeNull();
    expect(await balanceOf(userId)).toBe(FREE);
  });

  test("并发扣费不超付：10 路各扣 40k，总额度只够 7 笔", async () => {
    const { userId } = await registerUser();
    await walletSvc.getWallet(userId); // 300k
    const results = await Promise.all(Array.from({ length: 10 }, () => walletSvc.debit(userId, 40_000, "并发")));
    const ok = results.filter(Boolean).length;
    expect(ok).toBe(7); // 300k / 40k = 7 笔
    expect(await balanceOf(userId)).toBe(FREE - ok * 40_000);
    // ★ 关键断言：余额不能是负数。读-改-写的实现会在这里挂
    expect(await balanceOf(userId)).toBeGreaterThanOrEqual(0);
  });
});

describe("/api/ark 的扣费闸门", () => {
  test("出图成功：按这次用的 model 扣，响应头带回最新余额", async () => {
    const { token, userId } = await registerUser();
    mockArk(200, { data: [{ url: "https://x.volces.com/a.png" }] });
    const res = await request(app)
      .post("/api/ark/images/generations")
      .set(auth(token))
      .send({ model: "doubao-seedream-4-0-250828", prompt: "x" })
      .expect(200);
    expect(await balanceOf(userId)).toBe(FREE - IMAGE);
    expect(Number(res.headers["x-wallet-plan"])).toBe(FREE - IMAGE);
    expect(Number(res.headers["x-wallet-addon"])).toBe(0);
  });

  test("出图按档位定价：精绘档确实比速写档贵（写成一口价这条会红）", async () => {
    // ★ 这条钉的是一个**真实发生过**的缺口：priceOf 拿到了 body 却不读 model，
    //   顶档按最低档收 —— 用户无感、界面无错、测试全绿，只有火山账单知道。
    //   跨仓价目表的逐条对照在 arkProxy.spec.js，这里验的是"扣费链路真的用上了它"。
    const cases = [
      ["doubao-seedream-4-0-250828", 13_333], // 速写
      ["doubao-seedream-4-5-251128", 16_667], // 定妆
      ["doubao-seedream-5-0-pro-260628", 40_000], // 精绘
    ];
    for (const [model, cost] of cases) {
      const { token, userId } = await registerUser();
      mockArk(200, { data: [{ url: "https://x.volces.com/a.png" }] });
      await request(app).post("/api/ark/images/generations").set(auth(token)).send({ model, prompt: "x" }).expect(200);
      expect({ model, spent: FREE - (await balanceOf(userId)) }).toEqual({ model, spent: cost });
    }
  });

  test("视频按时长与档位定价：极速档比标准档便宜", async () => {
    const { token: t1, userId: u1 } = await registerUser();
    const { token: t2, userId: u2 } = await registerUser();
    mockArk(200, { id: "task_1" });
    const body = (model) => ({ model, content: [], duration: 5 });
    await request(app).post("/api/ark/contents/generations/tasks").set(auth(t1)).send(body("doubao-seedance-1-0-pro-250528")).expect(200);
    await request(app).post("/api/ark/contents/generations/tasks").set(auth(t2)).send(body("doubao-seedance-1-0-pro-fast-251015")).expect(200);
    const spentStd = FREE - (await balanceOf(u1));
    const spentFast = FREE - (await balanceOf(u2));
    expect(spentStd).toBe(108_000); // 5×1280×720×24/1024
    // ⚠ 2026-08-16 按 8 月账单把极速档从 0.3 改成 4.2/15（账单 ¥0.0042/千token）：
    //   30,240 而不是 32,400。**这个数字要跟着账单走**，别看到红就改回 0.3 ——
    //   0.3 比真实成本高 7%，方向是多收用户。系数的出处写在 config/tokens.js 的 VIDEO_MULT。
    expect(spentFast).toBe(Math.round(108_000 * (4.2 / 15)));
  });

  test("W2 上游 400（敏感词）→ 原路退回，余额不变，流水一扣一退", async () => {
    const { token, userId } = await registerUser();
    mockArk(400, { error: { message: "InputTextSensitiveContentDetected" } });
    await request(app)
      .post("/api/ark/chat/completions")
      .set(auth(token))
      .send({ model: "doubao-seed-2-1-turbo-260628", messages: [] })
      .expect(400);
    expect(await balanceOf(userId)).toBe(FREE);
    const rows = await TokenLedger.find({ user: userId }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => r.reason)).toEqual(["grant", "ark_spend", "ark_refund"]);
    expect(rows[1].delta).toBe(-CHAT);
    expect(rows[2].delta).toBe(CHAT);
  });

  test("W2 上游 429（限流）同样退回", async () => {
    const { token, userId } = await registerUser();
    mockArk(429, { error: { message: "rate limited" } });
    await request(app)
      .post("/api/ark/images/generations")
      .set(auth(token))
      .send({ model: "doubao-seedream-5-0-260128" })
      .expect(429);
    expect(await balanceOf(userId)).toBe(FREE);
  });

  test("没配 key 回 501 时也退回（否则每次误配都在白扣用户的钱）", async () => {
    const { token, userId } = await registerUser();
    delete process.env.ARK_API_KEY;
    await request(app)
      .post("/api/ark/images/generations")
      .set(auth(token))
      .send({ model: "doubao-seedream-5-0-260128" })
      .expect(501);
    expect(await balanceOf(userId)).toBe(FREE);
  });

  test("余额不足 → 402 + INSUFFICIENT_TOKENS，且【根本不打方舟】", async () => {
    const { token, userId } = await registerUser();
    const spy = mockArk(200, {});
    await walletSvc.getWallet(userId);
    await walletSvc.debit(userId, FREE, "掏空");
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth(token))
      .send({ model: "doubao-seedance-1-0-pro-250528", content: [], duration: 10 })
      .expect(402);
    expect(res.body.code).toBe("INSUFFICIENT_TOKENS");
    expect(res.body.need).toBe(216_000);
    expect(spy).not.toHaveBeenCalled(); // ★ 这条才是"钱包搬到服务端"的意义
  });

  test("轮询任务状态不计费（一段视频要轮询上百次）", async () => {
    const { token, userId } = await registerUser();
    mockArk(200, { status: "running" });
    await walletSvc.getWallet(userId);
    for (let i = 0; i < 5; i++) {
      await request(app).get("/api/ark/contents/generations/tasks/abc123").set(auth(token)).expect(200);
    }
    expect(await balanceOf(userId)).toBe(FREE);
  });
});

// ★ 这里原来是「模拟支付的防滥用上限」：那时 /recharge 与 /plan 调一下就到账，
//   靠 DAILY_RECHARGE_CAP / DAILY_PLAN_BUYS 兜底不让脚本刷出天量额度。
//   2026-08 发币口搬到了支付回调（见 tests/payOrder.spec.js），这两条路径只剩下单，
//   每日上限也就没有存在意义了——不给币，刷多少次都是 0。
//   保留下面这组用例是为了钉住「它们真的不发币了」这件事本身。
describe("老的钱包路径只下单、不发币", () => {
  test("直充：只收在册面额，且返回 202 而不是 200", async () => {
    const { token, userId } = await registerUser();
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 999_999_999 }).expect(400);
    // ★ 202 = 请求收下了，但余额还没变。用 200 的话老客户端会当成充值成功
    const res = await request(app)
      .post("/api/me/wallet/recharge")
      .set(auth(token))
      .send({ tokens: 1_000_000 })
      .expect(202);
    expect(res.body.order.status).toBe("created");
    expect(await balanceOf(userId)).toBe(FREE);
  });

  test("套餐：未知档位挡掉；合法档位只下单，额度不到账", async () => {
    const { token, userId } = await registerUser();
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    await request(app).post("/api/me/wallet/plan").set(auth(token)).send({ planId: "hacker" }).expect(400);
    const res = await request(app).post("/api/me/wallet/plan").set(auth(token)).send({ planId: "pro" }).expect(202);
    expect(res.body.order.planId).toBe("pro");
    expect(res.body.wallet.planId).not.toBe("pro"); // 没付款就不该生效
    expect(await balanceOf(userId)).toBe(FREE);
  });

  test("刷多少次都刷不出额度（这正是改成订单要堵的洞）", async () => {
    const { token, userId } = await registerUser();
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 5_000_000 });
    }
    expect(await balanceOf(userId)).toBe(FREE);
  });
});

describe("流水与余额对得上", () => {
  test("所有 delta 之和 === 当前余额", async () => {
    const { token, userId } = await registerUser();
    mockArk(200, { data: [{ url: "u" }] });
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    // ★ 这里原来先充 200k 再花：充值已经不发币了，留着它这条断言就恒等于"只有 grant + spend"。
    //   对账要验的是"每一笔变动都有流水"，用 grant + 三次 ark_spend 一样能验到。
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/ark/images/generations")
        .set(auth(token))
        .send({ model: "doubao-seedream-5-0-260128" })
        .expect(200);
    }
    const rows = await TokenLedger.find({ user: userId }).lean();
    const sum = rows.reduce((a, r) => a + r.delta, 0);
    expect(sum).toBe(await balanceOf(userId));
  });
});
