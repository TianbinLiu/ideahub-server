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
const IMAGE = 13_300;
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
  test("出图成功：按 IMAGE_TOKENS 扣，响应头带回最新余额", async () => {
    const { token, userId } = await registerUser();
    mockArk(200, { data: [{ url: "https://x.volces.com/a.png" }] });
    const res = await request(app)
      .post("/api/ark/images/generations")
      .set(auth(token))
      .send({ model: "doubao-seedream-5-0-260128", prompt: "x" })
      .expect(200);
    expect(await balanceOf(userId)).toBe(FREE - IMAGE);
    expect(Number(res.headers["x-wallet-plan"])).toBe(FREE - IMAGE);
    expect(Number(res.headers["x-wallet-addon"])).toBe(0);
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
    expect(spentFast).toBe(Math.round(108_000 * 0.3));
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

describe("模拟支付的防滥用上限", () => {
  test("只收在册面额（不许充任意数字）", async () => {
    const { token } = await registerUser();
    await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 999_999_999 }).expect(400);
    await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 1_000_000 }).expect(200);
  });

  test("未知套餐挡掉；买了套餐额度立刻到账并记住档位", async () => {
    const { token, userId } = await registerUser();
    await request(app).post("/api/me/wallet/plan").set(auth(token)).send({ planId: "hacker" }).expect(400);
    const res = await request(app).post("/api/me/wallet/plan").set(auth(token)).send({ planId: "pro" }).expect(200);
    expect(res.body.wallet.planId).toBe("pro");
    expect(await balanceOf(userId)).toBe(FREE + 8_000_000);
  });

  test("每日直充有上限，刷不出天量额度", async () => {
    const { token } = await registerUser();
    for (let i = 0; i < 2; i++) {
      await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 5_000_000 }).expect(200);
    }
    await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 5_000_000 }).expect(429);
  });
});

describe("流水与余额对得上", () => {
  test("所有 delta 之和 === 当前余额", async () => {
    const { token, userId } = await registerUser();
    mockArk(200, { data: [{ url: "u" }] });
    await request(app).get("/api/me/wallet").set(auth(token)).expect(200);
    await request(app).post("/api/me/wallet/recharge").set(auth(token)).send({ tokens: 200_000 }).expect(200);
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
