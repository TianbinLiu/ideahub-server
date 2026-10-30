// tests/minimaxV2.spec.js
// 覆盖：MiniMax H3（V2 出片，2026-10-26）的两条路由 —— POST /api/minimax/v2/video、GET /api/minimax/v2/video/:taskId，
// 以及它们接着的几处：失败退款（taskRefund 的 api:"v2" 一支 + 清扫器问 V2 端点）、全站与按人两道并发闸（含同一进程里的竞态）、
// /api/ark/health 的 minimaxV2、成片主机进产物代理与转存白名单、取回登记（GET /api/minimax/video-tasks）。
//
// ★ 不花钱、不出网：fetch 换成间谍，按 URL 回假的上游回包；「没出网」由间谍断言，不靠推理。
// ★ 这一组判据错了都**零症状**，所以每一条都有反例：
//   · 白名单松了 —— callback_url / video_url 直通上游（拿我们的 key 替别人发请求、输入视频另收钱我们没收）；
//   · 上游的 401 / 402 原样回给 App —— App 把人踢回登录页、叫用户去充值（都是错话）；
//   · 退款只认 v1 的 Fail —— H3 明说失败也永远不退钱（2026-10-26 设计审核的头一条）；
//   · 并发闸挂在扣费之后 —— 扣了又退，还白打上游的限流额度；只有全站闸 —— 一个账号占满全站的位；
//     数完与占位之间多一个 await —— 同一进程里同时进来的两发都挤进最后一个位；
//   · 受理之后没登记 —— App 被杀两次那一发就再也找不回来（钱照收）；登记混进方舟那张表 —— 老 App 拿 H3 的号去问方舟；
//   · 查询不看归属 —— H3 的任务号几乎连号，挨个猜就能拿到别人的成片。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

// 产物代理 / 转存前的 DNS 兜底会真去解析主机名（出网）：这一套只测白名单，DNS 那一道换成放行
jest.mock("../src/utils/ssrfGuard", () => ({ ...jest.requireActual("../src/utils/ssrfGuard"), assertPublicUrl: jest.fn(async () => {}) }));

let mongod;
let app;
let wallet;
let User;
let TokenLedger;
let GenTaskCharge;
let ArkVideoTask;
let taskRefund;
let cloudinary;
let savedCloud;
let fetchSpy;
let calls;
/** 建任务那一发上游怎么回（每条用例可以换） */
let createReply;
/** 查询那一发上游怎么回：taskId → (url) => 回包 */
let queryReplies;

const V2 = "https://api.minimax.io/v2";
const CLOUD = "testcloud";
const LITE = "MiniMax-H3-Lite";
const HS = "MiniMax-H3-Highspeed";
const H3 = "MiniMax-H3";
const CDN = "https://video-product.cdn.minimax.io/h3-480p/2000/01/01/test/100000000000001-1-0000000000000000_aigc.mp4";

const ENV_KEYS = ["MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY", "MINIMAX_REGION", "MINIMAX_FAIL_REFUND", "VIDEO_REGION_GATE", "VIDEO_ZONE_FORCE", "FREE_VIDEO_GATE"];
let savedEnv;

const resp = (status, obj) => ({ status, text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)) });
const oaiError = (status, type, message) => resp(status, { type: "error", error: { type, message, http_code: String(status) }, request_id: "r" });

const text = (t = "海边，女孩回头一笑") => ({ type: "text", text: t });
const ourImg = (name = "a") => `https://res.cloudinary.com/${CLOUD}/image/upload/v1/ideahub/content-images/${name}.jpg`;
const img = (role, url = ourImg()) => ({ type: "image_url", image_url: { url }, role });
/** 一段纯文字的 H3-Lite · 480P · 5 秒（= 56,000） */
const liteBody = (o = {}) => ({ model: LITE, resolution: "480P", duration: 5, ratio: "9:16", content: [text()], ...o });

let seq = 0;
async function registerUser(tag, { plan = "std", topUp = 2_000_000 } = {}) {
  seq += 1;
  const name = `mv2_${tag}_${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  const id = res.body.user._id;
  if (plan) {
    await wallet.buyPlan(id, plan);
    // 余额摆到一个够花的数（这一套测的是转发、退款与门，不是余额门）
    await User.updateOne({ _id: id }, { $set: { "tokenWallet.plan": topUp, "tokenWallet.addon": 0, "tokenWallet.debt": 0 } });
  }
  return { id, auth: { Authorization: `Bearer ${res.body.token}` } };
}

const balance = async (id) => {
  const w = await wallet.getWallet(id);
  return w.plan + w.addon;
};

/** 出网记录里打到某个前缀的几发 */
const callsTo = (prefix) => calls.filter((c) => c.url.startsWith(prefix));

/**
 * 让同时进来的 n 发请求都**数完**之后才一起往下走（并发闸的竞态用例用）：把数数的那个函数包一层，第 n 发到了才放行。
 * ★ 不这么摆的话，两发谁先谁后全看事件循环 —— 闸写坏了（数完到占位之间多一个 await）也可能碰巧排成一前一后、照样全绿。
 *   摆了之后两发一定拿着同一个数一起往下走：闸是好的 → 先往下走的那一发同步占位、后一发看得见；坏了 → 两发都挤进最后一个位。
 * 只到了一发（别处先拒了另一发）也别把用例挂死：5 秒后自己放行。
 * @returns {() => void} 收尾（还原那个函数）
 */
function barrierOn(obj, name, n) {
  const real = obj[name];
  let arrived = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const timer = setTimeout(() => release(), 5000);
  const spy = jest.spyOn(obj, name).mockImplementation(async (...args) => {
    const v = await real.apply(obj, args);
    arrived += 1;
    if (arrived >= n) release();
    await gate;
    return v;
  });
  return () => {
    clearTimeout(timer);
    spy.mockRestore();
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  wallet = require("../src/services/tokenWallet.service");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  GenTaskCharge = require("../src/models/GenTaskCharge");
  ArkVideoTask = require("../src/models/ArkVideoTask");
  taskRefund = require("../src/services/taskRefund.service");
  cloudinary = require("../src/config/cloudinary").cloudinary;
  savedCloud = cloudinary.config().cloud_name;
  cloudinary.config({ cloud_name: CLOUD });
});

afterAll(async () => {
  cloudinary.config({ cloud_name: savedCloud });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await TokenLedger.deleteMany({});
  await GenTaskCharge.deleteMany({});
  await ArkVideoTask.deleteMany({});
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // 缺省：只配国际站（V2 开着）
  process.env.MINIMAX_INTL_API_KEY = "mm-intl-test-not-real";
  calls = [];
  createReply = () => resp(200, { task_id: "100000000000001" });
  queryReplies = {};
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    if (u === `${V2}/video_generation`) return createReply(u, init);
    if (u.startsWith(`${V2}/query/video_generation/`)) {
      const id = u.slice(u.lastIndexOf("/") + 1);
      return queryReplies[id] ? queryReplies[id](u) : resp(200, { task: { id, model: LITE, status: "running" } });
    }
    if (u === CDN) return new Response("mp4-bytes", { status: 200, headers: { "content-type": "video/mp4" } });
    throw new Error(`测试里没有为这个地址准备回应：${u}`);
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("开关：只在国际站开（config/minimax.minimaxV2Enabled）", () => {
  test.each([
    ["没配 key", {}],
    ["只配中国站", { MINIMAX_API_KEY: "mm-cn-test" }],
    ["两把都配、指定中国站", { MINIMAX_API_KEY: "mm-cn-test", MINIMAX_INTL_API_KEY: "mm-intl-test", MINIMAX_REGION: "cn" }],
  ])("%s → 两条都 501 MINIMAX_V2_OFF（扣费之前，不出网）；health 的 minimaxV2 是 false", async (_l, env) => {
    delete process.env.MINIMAX_INTL_API_KEY;
    Object.assign(process.env, env);
    const u = await registerUser("off");
    const before = await balance(u.id);
    const post = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(post.status).toBe(501);
    expect(post.body).toMatchObject({ ok: false, code: "MINIMAX_V2_OFF" });
    expect(post.body.message).toMatch(/没有扣费/);
    const get = await request(app).get("/api/minimax/v2/video/100000000000001").set(u.auth);
    expect(get.status).toBe(501);
    expect(get.body.code).toBe("MINIMAX_V2_OFF");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body.minimaxV2).toBe(false);
  });

  test("国际站 → health 的 minimaxV2 是 true（只说有没有，不带 key / 地址）；minimaxV2FreeTextOnly 原样报 tokens 那个常量", async () => {
    const h = await request(app).get("/api/ark/health").expect(200);
    expect(h.body.minimaxV2).toBe(true);
    expect(h.body.minimaxV2FreeTextOnly).toBe(require("../src/config/tokens").MINIMAX_V2_FREE_TEXT_ONLY);
    expect(h.body.minimaxV2FreeTextOnly).toBe(true);
    expect(JSON.stringify(h.body)).not.toMatch(/mm-intl|minimax\.io/);
  });

  test("未登录 → 401，不出网", async () => {
    await request(app).post("/api/minimax/v2/video").send(liteBody()).expect(401);
    await request(app).get("/api/minimax/v2/video/100000000000001").expect(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("请求体白名单：名单外的一律整句拒（400 VIDEO_PARAMS_NOT_ALLOWED，扣费之前、不出网）", () => {
  const six = Array.from({ length: 6 }, (_, i) => img("reference_image", ourImg(`r${i}`)));
  const cases = [
    ["顶层多一个 callback_url（拿我们的 key 替别人往任意地址 POST）", liteBody({ callback_url: "https://evil.example.com/hook" }), /callback_url/],
    ["顶层多一个 extra（H3-Max 的提示词扩写）", liteBody({ extra: { prompt_expansion_mode: "quality" } }), /extra/],
    ["顶层多一个 first_frame_image（v1 的写法）", liteBody({ first_frame_image: ourImg() }), /first_frame_image/],
    ["条目是 video_url（输入视频另按时长收）", liteBody({ content: [text(), { type: "video_url", video_url: { url: ourImg() }, role: "reference_video" }] }), /类型不认/],
    ["条目是 audio_url", liteBody({ content: [text(), { type: "audio_url", audio_url: { url: ourImg() }, role: "reference_audio" }] }), /类型不认/],
    ["text 条目上挂着 video_url", liteBody({ content: [{ ...text(), video_url: { url: ourImg() } }] }), /video_url/],
    ["image_url 对象里多一个键", liteBody({ content: [text(), { type: "image_url", image_url: { url: ourImg(), detail: "high" }, role: "reference_image" }] }), /detail/],
    // 原样的 JSON 文本：交给 supertest 一个对象的话，它拷贝时 `__proto__` 会变成原型、根本发不出去
    ["__proto__ 键（JSON.parse 出来的自有键）", JSON.stringify(liteBody()).replace("{", '{"__proto__":{"x":1},'), /__proto__/],
    ["model 是 H3-Max（没有对标档位）", liteBody({ model: "MiniMax-H3-Max" }), /model 只收/],
    ["model 是 v1 的海螺", liteBody({ model: "MiniMax-Hailuo-2.3-Fast" }), /model 只收/],
    ["H3-Lite 写 768P（没开的那一格）", liteBody({ resolution: "768P" }), /只出 480P/],
    ["H3 写 2K（没开的那一格）", liteBody({ model: H3, resolution: "2K" }), /只出 768P/],
    ["分辨率写小写 480p（不是上游的写法）", liteBody({ resolution: "480p" }), /只出 480P/],
    ["时长 3 秒（窗口 4~15）", liteBody({ duration: 3 }), /4~15/],
    ["时长 16 秒", liteBody({ duration: 16 }), /4~15/],
    ["时长 5.5（上游只收整数枚举，不替它取整）", liteBody({ duration: 5.5 }), /整数/],
    ["时长写成字符串 \"5\"", liteBody({ duration: "5" }), /整数/],
    ["没有文字", liteBody({ content: [img("reference_image")] }), /文字/],
    ["两条文字", liteBody({ content: [text(), text("b")] }), /只能有一条文字/],
    ["文字只有空白", liteBody({ content: [text("   ")] }), /不能是空的/],
    ["文字 2001 个字（按字符数，不按 UTF-16）", liteBody({ content: [text("😀".repeat(2001))] }), /最多 2000/],
    ["role 是 reference_video", liteBody({ content: [text(), { type: "image_url", image_url: { url: ourImg() }, role: "reference_video" }] }), /role 只收/],
    ["图片没写 role（上游会当首帧 —— 我们要写明）", liteBody({ content: [text(), { type: "image_url", image_url: { url: ourImg() } }] }), /role 只收/],
    ["首帧与参考图混发（官方：两种场景互斥）", liteBody({ ratio: undefined, content: [text(), img("first_frame"), img("reference_image")] }), /不能放在同一段/],
    ["两张首帧", liteBody({ ratio: undefined, content: [text(), img("first_frame"), img("first_frame")] }), /首帧只能有一张/],
    ["6 张参考图（第 6 张起上游另收钱）", liteBody({ content: [text(), ...six] }), /最多/],
    ["图是 data: 内联", liteBody({ content: [text(), img("reference_image", "data:image/png;base64,QQ==")] }), /图床/],
    ["图是 http（不是 https）", liteBody({ content: [text(), img("reference_image", ourImg().replace("https:", "http:"))] }), /图床/],
    ["图在别人的 Cloudinary（同一个域，别的 cloud）", liteBody({ content: [text(), img("reference_image", "https://res.cloudinary.com/othercloud/image/upload/a.jpg")] }), /图床/],
    ["图是方舟的临时链接", liteBody({ content: [text(), img("reference_image", "https://ark-content.tos-cn-beijing.volces.com/a.png")] }), /图床/],
    ["图是任意网址", liteBody({ content: [text(), img("reference_image", "https://evil.example.com/a.jpg")] }), /图床/],
    ["图的地址带账号密码", liteBody({ content: [text(), img("reference_image", `https://u:p@res.cloudinary.com/${CLOUD}/image/upload/a.jpg`)] }), /图床/],
    ["纯文字出片不写画幅（官方硬规矩）", liteBody({ ratio: undefined }), /纯文字出片要写明画幅/],
    ["纯文字出片写 adaptive", liteBody({ ratio: "adaptive" }), /纯文字出片要写明画幅/],
    ["参考图出片写 adaptive（H3-Lite 不收）", liteBody({ ratio: "adaptive", content: [text(), img("reference_image")] }), /参考图出片要写明画幅/],
    ["参考图出片写 adaptive（Highspeed 上游收，我们也要具体比例：一条规矩）", liteBody({ model: HS, resolution: "768P", ratio: "adaptive", content: [text(), img("reference_image")] }), /参考图出片要写明画幅/],
    ["首帧出片写 9:16（上游会悄悄当 adaptive）", liteBody({ ratio: "9:16", content: [text(), img("first_frame")] }), /只能是 adaptive/],
    ["画幅写 2:1（不在枚举里）", liteBody({ ratio: "2:1" }), /ratio 只收/],
    ["请求体不是对象", [liteBody()], /JSON 对象/],
  ];

  test.each(cases)("%s", async (_label, body, why) => {
    const u = await registerUser("wl");
    const before = await balance(u.id);
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code: "VIDEO_PARAMS_NOT_ALLOWED" });
    expect(res.body.message).toMatch(why);
    expect(res.body.message).toMatch(/没有扣费/);
    // 拒绝话里不带 ASCII 双引号 / 反斜杠 / 换行（客户端给的键名过 safeName）
    expect(res.body.message).not.toMatch(/["\\\n]/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
    expect(await GenTaskCharge.countDocuments({})).toBe(0);
  });

  test("对照：2000 个字（哪怕每个字在 UTF-16 里占两格）照常受理", async () => {
    const u = await registerUser("wl_ok");
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody({ content: [text("😀".repeat(2000))] }));
    expect(res.status).toBe(200);
  });

  // 2026-10-26 终审：原来按 `[...text].length` 数字数 —— 一条 4000 万字的提示词要先摊成 4000 万个元素的数组（实测卡事件循环约 1.6 秒、多占约 1GB），
  // 之后才回「最多 2000 个字」；这一步排在扣费与并发闸之前，任何登录用户都能不花钱地连着发。
  test("超长的提示词：不逐字摊开就拒（形状一关按长度先拦），拒绝话还是那一句", () => {
    const { parseV2CreateBody } = require("../src/schemas/minimaxV2.schemas");
    const realIter = String.prototype[Symbol.iterator];
    // 谁要是把超长的那一整串交给字符串迭代器（展开、for…of、Array.from）就当场红
    String.prototype[Symbol.iterator] = function iterGuard() {
      if (this.length > 4000) throw new Error(`把一条 ${this.length} 格的字符串逐字摊开了`);
      return realIter.call(this);
    };
    try {
      for (const n of [4001, 5_000_000]) {
        const r = parseV2CreateBody(liteBody({ content: [text("a".repeat(n))] }));
        expect({ n, ok: r.ok, message: r.message }).toEqual({ n, ok: false, message: "提示词最多 2000 个字" });
      }
      // 边界：2000 个占两格的字照收，2001 个拒（按字数，不按 UTF-16 长度）
      expect(parseV2CreateBody(liteBody({ content: [text("😀".repeat(2000))] })).ok).toBe(true);
      expect(parseV2CreateBody(liteBody({ content: [text("😀".repeat(2001))] })).message).toBe("提示词最多 2000 个字");
      expect(parseV2CreateBody(liteBody({ content: [text(`${"😀".repeat(1999)}ab`)] })).message).toBe("提示词最多 2000 个字");
      expect(parseV2CreateBody(liteBody({ content: [text(`${"😀".repeat(1999)}a`)] })).ok).toBe(true);
    } finally {
      String.prototype[Symbol.iterator] = realIter;
    }
  });

  test("路由上：几十万字的提示词 400（扣费之前、不出网）；超过 1MB 的请求体在白名单之前就 413 —— /v2 不吃 /api/minimax 那 50MB 的大 body", async () => {
    const u = await registerUser("wl_big");
    const before = await balance(u.id);
    const long = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody({ content: [text("a".repeat(600_000))] }));
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ code: "VIDEO_PARAMS_NOT_ALLOWED" });
    expect(long.body.message).toMatch(/最多 2000/);
    const huge = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody({ content: [text("a".repeat(1_200_000))] }));
    expect(huge.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
    // 对照：真人档（v1）照旧吃大 body（首帧可以是 base64）—— 同样大的请求体解析得了、走到路由里（表外时长 → 400，也在扣费之前）
    const v1 = await request(app)
      .post("/api/minimax/video")
      .set(u.auth)
      .send({ model: "MiniMax-Hailuo-2.3-Fast", duration: 7, prompt: "a".repeat(1_200_000) });
    expect(v1.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("受理：按秒扣钱、发出去的是重建过的那一份、记一笔 H3 的账", () => {
  test("纯文字 H3-Lite · 480P · 5 秒：打国际站 /v2、请求体逐字段相等、扣 56,000、账上 api:v2 / kind:video / region:intl", async () => {
    const u = await registerUser("ok");
    const before = await balance(u.id);
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, task_id: "100000000000001" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${V2}/video_generation`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer mm-intl-test-not-real");
    // toEqual 双向比较：少转发一个、多漏一个都会红
    expect(JSON.parse(calls[0].body)).toEqual({ model: LITE, resolution: "480P", duration: 5, ratio: "9:16", content: [text()] });
    expect(before - (await balance(u.id))).toBe(5 * 11_200);
    expect(Number(res.headers["x-wallet-plan"]) + Number(res.headers["x-wallet-addon"])).toBe(await balance(u.id));
    const row = await GenTaskCharge.findOne({ provider: "minimax", taskId: "100000000000001" }).lean();
    expect(row).toMatchObject({ api: "v2", kind: "video", region: "intl", model: LITE, charged: 56_000, state: "open" });
  });

  test("首尾帧（不写画幅）→ 转发时补成 adaptive；只给尾帧也收", async () => {
    const u = await registerUser("frames");
    const fl = await request(app)
      .post("/api/minimax/v2/video")
      .set(u.auth)
      .send(liteBody({ ratio: undefined, content: [text(), img("first_frame", ourImg("f")), img("last_frame", ourImg("l"))] }));
    expect(fl.status).toBe(200);
    expect(JSON.parse(calls[0].body)).toMatchObject({ ratio: "adaptive" });
    expect(JSON.parse(calls[0].body).content).toEqual([text(), img("first_frame", ourImg("f")), img("last_frame", ourImg("l"))]);
    createReply = () => resp(200, { task_id: "100000000000002" });
    const lastOnly = await request(app)
      .post("/api/minimax/v2/video")
      .set(u.auth)
      .send(liteBody({ ratio: "adaptive", content: [text(), img("last_frame")] }));
    expect(lastOnly.status).toBe(200);
  });

  test("5 张参考图的 H3-Highspeed · 768P · 7 秒：图不另收钱（都在官方免费张数里），扣 7 × 26,900", async () => {
    const u = await registerUser("refs");
    const before = await balance(u.id);
    const five = Array.from({ length: 5 }, (_, i) => img("reference_image", ourImg(`r${i}`)));
    const res = await request(app)
      .post("/api/minimax/v2/video")
      .set(u.auth)
      .send({ model: HS, resolution: "768P", duration: 7, ratio: "9:16", content: [text(), ...five] });
    expect(res.status).toBe(200);
    expect(before - (await balance(u.id))).toBe(7 * 26_900);
  });

  test("MiniMax-H3 · 768P · 15 秒（最长一段）= 537,000", async () => {
    const u = await registerUser("h3");
    const before = await balance(u.id);
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody({ model: H3, resolution: "768P", duration: 15 }));
    expect(res.status).toBe(200);
    expect(before - (await balance(u.id))).toBe(15 * 35_800);
  });

  test("上游把 task_id 写成数字也认（不然就是「上游建了任务、我们当没受理把钱退了」）", async () => {
    createReply = () => resp(200, { task_id: 100000000000003 });
    const u = await registerUser("numid");
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe("100000000000003");
    expect(await GenTaskCharge.countDocuments({ taskId: "100000000000003", api: "v2" })).toBe(1);
  });

  test("免费版：H3-Lite · 480P 能出（免费档里的「草稿」）；H3-Highspeed → 403 PLAN_REQUIRED、不出网、不扣钱", async () => {
    const free = await registerUser("free", { plan: null });
    const before = await balance(free.id);
    const ok = await request(app).post("/api/minimax/v2/video").set(free.auth).send(liteBody({ duration: 4 }));
    expect(ok.status).toBe(200);
    expect(before - (await balance(free.id))).toBe(4 * 11_200);
    calls.length = 0;
    const mid = await balance(free.id);
    const hs = await request(app).post("/api/minimax/v2/video").set(free.auth).send(liteBody({ model: HS, resolution: "768P" }));
    expect(hs.status).toBe(403);
    expect(hs.body.code).toBe("PLAN_REQUIRED");
    expect(calls).toHaveLength(0);
    expect(await balance(free.id)).toBe(mid);
  });

  // 2026-10-26 终审：H3 收不收真人照片没验过、服务端又分不出图里是不是真人 —— 免费的 H3-Lite 带图就可能是不花钱的真人出片。
  // 在有结论之前（契约「等主人拍板」第 9 条），没付过钱的人在 H3 上只能纯文字（tokens.MINIMAX_V2_FREE_TEXT_ONLY）。
  test("免费版带图（首帧 / 尾帧 / 参考图）→ 403 PLAN_REQUIRED + freeTextOnly、不出网、不扣钱；纯文字照常；付过钱的与管理员带图照常", async () => {
    let n = 0;
    createReply = () => resp(200, { task_id: String(700_000 + ++n) }); // 每一发一个号：同号会撞上前一发的账（那是另一条用例）
    const free = await registerUser("free_img", { plan: null });
    const before = await balance(free.id);
    const withImg = [
      liteBody({ ratio: undefined, content: [text(), img("first_frame")] }),
      liteBody({ ratio: undefined, content: [text(), img("last_frame")] }),
      liteBody({ content: [text(), img("reference_image")] }),
    ];
    for (const b of withImg) {
      const res = await request(app).post("/api/minimax/v2/video").set(free.auth).send(b);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, code: "PLAN_REQUIRED", freeTextOnly: true });
      expect(res.body.allowed).toBeUndefined();
      expect(res.body.message).toMatch(/只能用文字出片/);
    }
    expect(calls).toHaveLength(0);
    expect(await balance(free.id)).toBe(before);
    expect(await GenTaskCharge.countDocuments({})).toBe(0);
    expect((await request(app).post("/api/minimax/v2/video").set(free.auth).send(liteBody())).status).toBe(200);

    const paid = await registerUser("paid_img");
    for (const b of withImg) {
      await GenTaskCharge.deleteMany({}); // 按人的并发闸（4 发）不是这一条测的
      expect((await request(app).post("/api/minimax/v2/video").set(paid.auth).send(b)).status).toBe(200);
    }
    const admin = await registerUser("admin_img", { plan: null });
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    await GenTaskCharge.deleteMany({});
    expect((await request(app).post("/api/minimax/v2/video").set(admin.auth).send(withImg[0])).status).toBe(200);
  });

  test("FREE_VIDEO_GATE=off 不放开这一条：H3 三档对免费版都开着，带图照样 403 freeTextOnly、纯文字照常", async () => {
    process.env.FREE_VIDEO_GATE = "off";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const free = await registerUser("free_gateoff", { plan: null });
      // 先让钱包建好（新人额度），再补一笔够出一段高清的余额（这一条测的是门，不是余额）
      await balance(free.id);
      await User.updateOne({ _id: free.id }, { $set: { "tokenWallet.addon": 2_000_000 } });
      const hsImg = await request(app)
        .post("/api/minimax/v2/video")
        .set(free.auth)
        .send({ model: HS, resolution: "768P", duration: 5, ratio: "9:16", content: [text(), img("reference_image")] });
      expect(hsImg.status).toBe(403);
      expect(hsImg.body).toMatchObject({ code: "PLAN_REQUIRED", freeTextOnly: true });
      expect(calls).toHaveLength(0);
      expect((await request(app).post("/api/minimax/v2/video").set(free.auth).send(liteBody({ model: HS, resolution: "768P" }))).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  test("出片地区门禁（on）：受全面制裁的地区 → 403 REGION_UNAVAILABLE、不出网不扣钱；美国 / 中国照常受理", async () => {
    process.env.VIDEO_REGION_GATE = "on";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await registerUser("region");
      const before = await balance(u.id);
      const ir = await request(app).post("/api/minimax/v2/video").set(u.auth).set({ "cf-ipcountry": "IR" }).send(liteBody());
      expect(ir.status).toBe(403);
      expect(ir.body).toMatchObject({ code: "REGION_UNAVAILABLE", billed: false });
      expect(calls).toHaveLength(0);
      expect(await balance(u.id)).toBe(before);
      for (const c of ["US", "CN"]) {
        const res = await request(app).post("/api/minimax/v2/video").set(u.auth).set({ "cf-ipcountry": c }).send(liteBody());
        expect(res.status).toBe(200);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-10-26（出片地区 × H3）：App 摆 H3 三档的规矩是「GET /api/video/zone 的 providers 有 minimax，且 GET /api/ark/health 的 minimaxV2 为真」
// （契约：routes/videoZone.routes 文件头、api-contract「出片地区」→「H3 三档摆不摆」）。两位在两个端点、各有各的判据
// （地区门禁按站判，config/videoRegion；V2 只在国际站开，config/minimax.minimaxV2Enabled），这里拿 V2 出片那一发逐个核：
// 照这条规矩摆出来的键点下去真受理、按秒扣钱；没摆出来的那一发真受理不了，而且是在扣费之前（403 / 501）。
// 两个方向错了都是零症状的：摆多了 = 一颗点下去必 403 / 501 的键；摆少了 = 海外的人（免费用户唯一能用的 H3-Lite 也在里面）白白看不见 H3。
describe("App 照 zone.providers + health.minimaxV2 摆 H3 三档：与 V2 出片那一发收不收是同一个答案（站 × 门禁 × 地区 × 三档）", () => {
  const { MINIMAX_SEC_COST } = require("../src/config/tokens");
  /** 价目表里的每一格（今天一个模型一格；以后多一格也照样逐格核） */
  const H3_ROWS = Object.entries(MINIMAX_SEC_COST).flatMap(([model, row]) =>
    Object.entries(row).map(([resolution, perSec]) => ({ model, resolution, perSec })),
  );
  const GATES = ["on", "observe", "off"];
  /** 境内 / 美国 / 港澳台（判境外）/ 受全面制裁 */
  const COUNTRIES = ["CN", "US", "HK", "IR"];
  /**
   * [说明, 这台服务器的 MiniMax 配置, 摆出来的格数, 没摆的格数]。格数写死不靠推：两边一起算错（规矩恒假、路由恒拒）时循环照样全绿。
   *   国际站：门禁 on 时受全面制裁的地区（IR）不摆、那一发 403；observe / off 一发都不拦，四个地区全摆。
   *   中国站 / 两把都配但指定中国站 / 没配：health 的 minimaxV2 恒假，一格都不摆，那一发都是 501（扣费之前）。
   */
  const SITES = [
    ["只配国际站（V2 开着）", { MINIMAX_INTL_API_KEY: "mm-intl-test-not-real" }, (3 + 4 + 4) * 3, 1 * 3],
    ["只配中国站（有真人档、没有 V2）", { MINIMAX_API_KEY: "mm-cn-test" }, 0, 12 * 3],
    ["两把都配、指定中国站", { MINIMAX_API_KEY: "mm-cn-test", MINIMAX_INTL_API_KEY: "mm-intl-test-not-real", MINIMAX_REGION: "cn" }, 0, 12 * 3],
    ["没配 MiniMax", {}, 0, 12 * 3],
  ];

  test("三档都在价目表里（下面的循环别空转）", () => {
    expect(H3_ROWS.map((r) => r.model)).toEqual(expect.arrayContaining([LITE, HS, H3]));
    expect(H3_ROWS).toHaveLength(3);
  });

  test.each(SITES)(
    "%s",
    async (_label, siteEnv, wantShown, wantHidden) => {
      delete process.env.MINIMAX_INTL_API_KEY;
      Object.assign(process.env, siteEnv);
      // observe 每一发该拦的都记一行 would-deny（console.warn），这一组不看日志
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const u = await registerUser("zone_h3");
        let shown = 0;
        let hidden = 0;
        for (const gate of GATES) {
          process.env.VIDEO_REGION_GATE = gate;
          for (const country of COUNTRIES) {
            const geo = { "cf-ipcountry": country };
            const zone = await request(app).get("/api/video/zone").set(geo).expect(200);
            const health = await request(app).get("/api/ark/health").set(geo).expect(200);
            const appShows = zone.body.providers.includes("minimax") && health.body.minimaxV2 === true;
            for (const { model, resolution, perSec } of H3_ROWS) {
              // 余额摆回去：这一组测的是收不收，不是余额门
              await User.updateOne({ _id: u.id }, { $set: { "tokenWallet.plan": 2_000_000, "tokenWallet.addon": 0, "tokenWallet.debt": 0 } });
              const before = await balance(u.id);
              const sent = callsTo(`${V2}/video_generation`).length;
              const res = await request(app).post("/api/minimax/v2/video").set(u.auth).set(geo).send(liteBody({ model, resolution }));
              const at = { site: _label, gate, country, model, appShows };
              if (appShows) {
                expect({ ...at, status: res.status, code: res.body.code }).toEqual({ ...at, status: 200, code: undefined });
                expect(before - (await balance(u.id))).toBe(5 * perSec);
                shown += 1;
              } else {
                const want = res.status === 403 ? "REGION_UNAVAILABLE" : "MINIMAX_V2_OFF";
                expect({ ...at, status: [403, 501].includes(res.status), code: res.body.code }).toEqual({ ...at, status: true, code: want });
                expect(res.body.billed === undefined || res.body.billed === false).toBe(true);
                expect(callsTo(`${V2}/video_generation`).length).toBe(sent);
                expect(await balance(u.id)).toBe(before);
                hidden += 1;
              }
              // 每受理一发就记一笔 open 的 H3 账：按人的并发闸（同时 4 发）会把后面的拦成 429 —— 这一组测的不是闸，清掉
              await GenTaskCharge.deleteMany({});
              await ArkVideoTask.deleteMany({});
              await TokenLedger.deleteMany({});
            }
          }
        }
        expect({ shown, hidden }).toEqual({ shown: wantShown, hidden: wantHidden });
      } finally {
        warn.mockRestore();
      }
    },
    60_000,
  );
});

// ─────────────────────────────────────────────────────────────────────
describe("上游没受理：钱退回，状态码换成我们自己的（401 / 402 原样回去，App 会把人踢回登录页 / 叫人去充值）", () => {
  const cases = [
    ["400 参数不对（2013）", () => oaiError(400, "bad_request_error", "invalid params, content must include a non-empty text item (2013)"), 400, "UPSTREAM_PARAMS", "2013"],
    ["422 内容审核（1026）", () => oaiError(422, "unprocessable_entity_error", "video description contains sensitive content (1026)"), 422, "UPSTREAM_SENSITIVE", "1026"],
    ["429 并发满（1045）", () => oaiError(429, "rate_limit_error", "rate limit exceeded(task concurrency) (1045)"), 503, "UPSTREAM_BUSY", "1045"],
    ["401 我们的 key 坏了（1004）", () => oaiError(401, "authorized_error", "login fail (1004)"), 502, "UPSTREAM_ERROR", "1004"],
    ["402 我们在 MiniMax 的余额不足（1008）", () => oaiError(402, "insufficient_balance_error", "insufficient balance (1008)"), 502, "UPSTREAM_ERROR", "1008"],
    ["500 上游坏了", () => oaiError(500, "server_error", "internal error (1000)"), 502, "UPSTREAM_ERROR", "1000"],
    ["200 却没有任务号（没法查、没法取，当没受理）", () => resp(200, { foo: 1 }), 502, "UPSTREAM_ERROR", ""],
    [
      "连不上 / 超时（forward 折成 504）",
      () => {
        throw new Error("boom");
      },
      504,
      "UPSTREAM_TIMEOUT",
      "",
    ],
  ];

  test.each(cases)("%s → %s %s，余额不变、不记账", async (_l, reply, status, code, upCode) => {
    createReply = reply;
    const quiet = [jest.spyOn(console, "error").mockImplementation(() => {}), jest.spyOn(console, "warn").mockImplementation(() => {})];
    try {
      const u = await registerUser("rej");
      const before = await balance(u.id);
      const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, code, billed: false });
      expect(res.body.upstream.code).toBe(upCode);
      expect(res.body.message).toMatch(/退回/);
      expect(await balance(u.id)).toBe(before);
      expect(await GenTaskCharge.countDocuments({})).toBe(0);
    } finally {
      quiet.forEach((s) => s.mockRestore());
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("全站并发闸：扣费之前拦（官方同时 30 发，我们到 25 就停）", () => {
  /** 摆 n 行「H3、还在跑」的账（别人的也算：这是全站的数） */
  async function seedOpen(n, o = {}) {
    const owner = await registerUser("seed");
    const docs = Array.from({ length: n }, (_, i) => ({
      provider: "minimax",
      api: "v2",
      taskId: `9${String(seq)}${String(i).padStart(4, "0")}`,
      kind: "video",
      user: owner.id,
      model: LITE,
      charged: 56_000,
      took: { plan: 56_000, addon: 0 },
      region: "intl",
      state: "open",
      ...o,
    }));
    await GenTaskCharge.insertMany(docs);
  }

  test("库里已有 25 发在跑 → 503 UPSTREAM_BUSY（带 Retry-After）、不出网、不扣钱", async () => {
    await seedOpen(25);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await registerUser("busy");
      const before = await balance(u.id);
      const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, code: "UPSTREAM_BUSY", billed: false });
      expect(res.headers["retry-after"]).toBe("30");
      expect(calls).toHaveLength(0);
      expect(await balance(u.id)).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });

  test("24 发 → 还放得下一发", async () => {
    await seedOpen(24);
    const u = await registerUser("room");
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(res.status).toBe(200);
  });

  test("已经有结局的（settled / refunded）、30 分钟之前受理的、不是 H3 的（真人档）都不算", async () => {
    await seedOpen(10, { state: "settled" });
    await seedOpen(10, { state: "refunded" });
    await seedOpen(10);
    await GenTaskCharge.collection.updateMany({ state: "open" }, { $set: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } });
    const owner = await registerUser("v1rows");
    await GenTaskCharge.insertMany(
      Array.from({ length: 25 }, (_, i) => ({ provider: "minimax", taskId: `v1-${i}`, kind: "minimax", user: owner.id, charged: 85_000, region: "intl", state: "open" })),
    );
    const u = await registerUser("notcounted");
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(res.status).toBe(200);
  });

  test("管理员免单的那几发（落库就是 skipped）在窗口里照样算在跑", async () => {
    await seedOpen(25, { state: "skipped", note: "free", free: true, charged: 0, took: { plan: 0, addon: 0 } });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await registerUser("adminrows");
      const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
      expect(res.status).toBe(503);
    } finally {
      warn.mockRestore();
    }
  });

  test("minimaxV2InFlight 只数 H3、窗口里、还在跑（或免单）的", async () => {
    await seedOpen(3);
    await seedOpen(2, { state: "claimed" });
    expect(await taskRefund.minimaxV2InFlight({ since: new Date(Date.now() - 60_000) })).toBe(3);
    expect(await taskRefund.minimaxV2InFlight({ since: new Date(Date.now() + 60_000) })).toBe(0);
  });

  test("同一进程里同时进来两发、全站只剩一个位 → 恰好一发受理、一发 503，上游只被打一发（数完到占位之间不许有 await）", async () => {
    await seedOpen(24);
    const a = await registerUser("raceA");
    const b = await registerUser("raceB");
    const before = { [a.id]: await balance(a.id), [b.id]: await balance(b.id) };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const done = barrierOn(taskRefund, "minimaxV2InFlight", 2);
    try {
      const rs = await Promise.all([a, b].map((u) => request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody())));
      expect(rs.map((r) => r.status).sort()).toEqual([200, 503]);
      expect(rs.find((r) => r.status === 503).body).toMatchObject({ code: "UPSTREAM_BUSY", billed: false });
      expect(callsTo(`${V2}/video_generation`)).toHaveLength(1);
      const loser = rs[0].status === 503 ? a : b;
      expect(await balance(loser.id)).toBe(before[loser.id]);
    } finally {
      done();
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("按人的并发闸：一个人同时最多 4 发（2026-10-26 审核：只有全站闸的话，一个账号就能占满全站的位）", () => {
  let batch = 0;
  /** 给某个人摆 count 行 H3 的账（缺省：还在跑） */
  async function seedMine(user, count, o = {}) {
    batch += 1;
    await GenTaskCharge.insertMany(
      Array.from({ length: count }, (_, i) => ({
        provider: "minimax",
        api: "v2",
        taskId: `7${batch}${String(i).padStart(4, "0")}`,
        kind: "video",
        user,
        model: LITE,
        charged: 56_000,
        took: { plan: 56_000, addon: 0 },
        region: "intl",
        state: "open",
        ...o,
      })),
    );
  }
  const post = (u) => request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());

  test("自己已有 4 发在跑 → 429 IN_FLIGHT_LIMIT（不是全站忙的 UPSTREAM_BUSY）、带 Retry-After、不出网、不扣钱；别人照常", async () => {
    const u = await registerUser("hog");
    await seedMine(u.id, 4);
    const before = await balance(u.id);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await post(u);
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ ok: false, code: "IN_FLIGHT_LIMIT", billed: false, limit: 4 });
      expect(res.body.message).toMatch(/没有扣费/);
      expect(res.headers["retry-after"]).toBe("30");
      expect(calls).toHaveLength(0);
      expect(await balance(u.id)).toBe(before);
      // 同一时刻别人照常（全站还远没到顶）
      const other = await registerUser("other");
      expect((await post(other)).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });

  test("自己 3 发 → 还能再出一发", async () => {
    const u = await registerUser("three");
    await seedMine(u.id, 3);
    expect((await post(u)).status).toBe(200);
  });

  test("不算的：已经有结局的、30 分钟之前受理的、真人档（v1）的、管理员免单的（免单的行永远不结，算它的话主人自己测完 4 段就要干等）", async () => {
    const u = await registerUser("mixed");
    await seedMine(u.id, 4);
    await GenTaskCharge.collection.updateMany({ user: new mongoose.Types.ObjectId(u.id) }, { $set: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } });
    await seedMine(u.id, 4, { state: "settled" });
    await seedMine(u.id, 4, { state: "refunded" });
    await seedMine(u.id, 4, { state: "skipped", note: "free", free: true, charged: 0, took: { plan: 0, addon: 0 } });
    await seedMine(u.id, 4, { api: undefined, kind: "minimax", model: "MiniMax-Hailuo-2.3-Fast" });
    expect((await post(u)).status).toBe(200);
  });

  test("minimaxV2InFlightOfUser 只数这个人的、H3 的、窗口里还 open 的", async () => {
    const u = await registerUser("cnt");
    const other = await registerUser("cnt2");
    await seedMine(u.id, 2);
    await seedMine(u.id, 1, { state: "claimed" });
    await seedMine(u.id, 1, { state: "skipped", free: true, charged: 0, took: { plan: 0, addon: 0 } });
    await seedMine(other.id, 3);
    const since = new Date(Date.now() - 60_000);
    expect(await taskRefund.minimaxV2InFlightOfUser({ since, user: u.id })).toBe(2);
    expect(await taskRefund.minimaxV2InFlightOfUser({ since: new Date(Date.now() + 60_000), user: u.id })).toBe(0);
    // 全站那一个照旧数免单的（它确实占过上游的位）
    expect(await taskRefund.minimaxV2InFlight({ since })).toBe(2 + 1 + 3);
  });

  test("同一个人同时进来两发、只剩一个位 → 恰好一发受理、一发 429，上游只被打一发（按人那一道也在同一段同步代码里占位）", async () => {
    const u = await registerUser("raceMe");
    await seedMine(u.id, 3);
    const before = await balance(u.id);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const done = barrierOn(taskRefund, "minimaxV2InFlightOfUser", 2);
    try {
      const rs = await Promise.all([post(u), post(u)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 429]);
      expect(rs.find((r) => r.status === 429).body.code).toBe("IN_FLIGHT_LIMIT");
      expect(callsTo(`${V2}/video_generation`)).toHaveLength(1);
      // 只扣了受理的那一发
      expect(before - (await balance(u.id))).toBe(56_000);
    } finally {
      done();
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-10-26 审核：两道并发闸排在 chargedArkCall 前面，而地区门禁挂在 chargedArkCall 上 —— 池子满的时候，受全面制裁地区的请求
// 收到的是「MiniMax 忙，过一会儿再点」/「等一段出来再点」，不是 REGION_UNAVAILABLE。App 只在收到 REGION_UNAVAILABLE 之后才重探地区，
// 于是照旧摆着 H3 三档、叫人重试，而重试永远不会成（零症状：钱上没事，只是那句话指错了方向）。所以路由在并发闸之前预检一次。
describe("地区门禁排在两道并发闸之前：池子满的时候，受制裁地区听到的仍是 REGION_UNAVAILABLE", () => {
  let batch = 0;
  /** 给 user 摆 count 行「H3、还在跑」的账 */
  async function seedOpenFor(user, count) {
    batch += 1;
    await GenTaskCharge.insertMany(
      Array.from({ length: count }, (_, i) => ({
        provider: "minimax",
        api: "v2",
        taskId: `5${batch}${String(i).padStart(4, "0")}`,
        kind: "video",
        user,
        model: LITE,
        charged: 56_000,
        took: { plan: 56_000, addon: 0 },
        region: "intl",
        state: "open",
      })),
    );
  }
  const post = (u, country) => request(app).post("/api/minimax/v2/video").set(u.auth).set({ "cf-ipcountry": country }).send(liteBody());
  /** console.warn 里记的 `[region] <kind>` 那几行 */
  const regionLines = (warn, kind) => warn.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith(`[region] ${kind} `));

  test("门禁 on、全站已有 25 发在跑：IR → 403 REGION_UNAVAILABLE（不是 503 UPSTREAM_BUSY）、不数并发、不出网、不扣钱；对照：US → 503", async () => {
    process.env.VIDEO_REGION_GATE = "on";
    const owner = await registerUser("poolOwner");
    await seedOpenFor(owner.id, 25);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const counted = jest.spyOn(taskRefund, "minimaxV2InFlight");
    try {
      const u = await registerUser("blockedBusy");
      const before = await balance(u.id);
      const ir = await post(u, "IR");
      expect(ir.status).toBe(403);
      expect(ir.body).toMatchObject({ ok: false, code: "REGION_UNAVAILABLE", reason: "region", zone: "blocked", billed: false });
      // 被拦的本来就是 MiniMax：「一家都没有」那一句（钱包没读也是这一句）
      expect(ir.body.message).toMatch(/^Video generation is not available in your region/);
      expect(ir.headers["retry-after"]).toBeUndefined();
      expect(counted).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(await balance(u.id)).toBe(before);
      // 一发只记一行 deny（预检拦下了，走不到 chargedArkCall 里那一处）
      expect(regionLines(warn, "deny")).toHaveLength(1);
      // 对照：池子是真满的 —— 不在受制裁地区的人照旧收到全站忙
      const us = await post(u, "US");
      expect(us.status).toBe(503);
      expect(us.body.code).toBe("UPSTREAM_BUSY");
    } finally {
      counted.mockRestore();
      warn.mockRestore();
    }
  });

  test("门禁 on、这个人自己已有 4 发在跑（在美国开的，又把 VPN 切到受制裁的地区）：IR → 403（不是 429 IN_FLIGHT_LIMIT）；对照：US → 429", async () => {
    process.env.VIDEO_REGION_GATE = "on";
    const u = await registerUser("vpnHop");
    await seedOpenFor(u.id, 4);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = await balance(u.id);
      const ir = await post(u, "IR");
      expect(ir.status).toBe(403);
      expect(ir.body).toMatchObject({ code: "REGION_UNAVAILABLE", billed: false });
      expect(calls).toHaveLength(0);
      expect(await balance(u.id)).toBe(before);
      const us = await post(u, "US");
      expect(us.status).toBe(429);
      expect(us.body.code).toBe("IN_FLIGHT_LIMIT");
    } finally {
      warn.mockRestore();
    }
  });

  test("门禁 observe：预检与 chargedArkCall 里那一处是同一个结论，一个请求只记一行 would-deny、照常受理（数日志时不会把一发算成两发）", async () => {
    process.env.VIDEO_REGION_GATE = "observe";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await registerUser("observeOnce");
      const res = await post(u, "IR");
      expect(res.status).toBe(200);
      const lines = regionLines(warn, "would-deny");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/at=\(minimax\)\/v2\/video_generation minimax_v2 MiniMax-H3-Lite zone=blocked/);
    } finally {
      warn.mockRestore();
    }
  });

  test("门禁 off：预检什么都不做（池子满了照旧 503，一行地区日志都没有）", async () => {
    process.env.VIDEO_REGION_GATE = "off";
    const owner = await registerUser("offPool");
    await seedOpenFor(owner.id, 25);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const u = await registerUser("offIR");
      const res = await post(u, "IR");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("UPSTREAM_BUSY");
      expect(warn.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("[region]"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("取回登记：App 被杀之后还找得回 H3 的那一发（GET /api/minimax/video-tasks，2026-10-26 审核）", () => {
  const post = (u, body = liteBody()) => request(app).post("/api/minimax/v2/video").set(u.auth).send(body);
  const list = (u) => request(app).get("/api/minimax/video-tasks").set(u.auth);

  test("受理那一拍登记一条：provider minimax / api v2、提示词、时长、画幅、分辨率（上游的写法）、实扣", async () => {
    const u = await registerUser("reg");
    await post(u, liteBody({ duration: 6, content: [text("雨夜，侦探推门")] })).expect(200);
    const row = await ArkVideoTask.findOne({ taskId: "100000000000001" }).lean();
    expect(row).toMatchObject({
      provider: "minimax",
      api: "v2",
      model: LITE,
      durationSec: 6,
      ratio: "9:16",
      resolution: "480P",
      prompt: "雨夜，侦探推门",
      costTokens: 6 * 11_200,
    });
    expect(String(row.userId)).toBe(String(u.id));
  });

  // 2026-10-26 文档审核：登记原来记的是 out.cost（报价），管理员免单的那一发也记成「花了 56,000」—— 方舟那张表记的是 out.free ? 0 : out.cost
  test("管理员免单的那一发：登记与列表里的 costTokens 是 0（实扣），不是报价；账是 skipped、余额不动", async () => {
    const admin = await registerUser("adminreg");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const before = await balance(admin.id);
    await post(admin).expect(200);
    expect(await balance(admin.id)).toBe(before);
    expect((await ArkVideoTask.findOne({ taskId: "100000000000001" }).lean()).costTokens).toBe(0);
    expect((await list(admin).expect(200)).body.tasks.map((t) => t.costTokens)).toEqual([0]);
    expect(await GenTaskCharge.findOne({ taskId: "100000000000001" }).lean()).toMatchObject({ state: "skipped", free: true, charged: 0 });
  });

  test("只列自己的、只列 H3 的；方舟那张表不列 H3（老 App 会拿列出来的号去问方舟）；列表不出网", async () => {
    const u = await registerUser("list");
    await post(u).expect(200);
    const other = await registerUser("list2");
    createReply = () => resp(200, { task_id: "100000000000004" });
    await post(other).expect(200);
    await ArkVideoTask.create({ userId: u.id, taskId: "cgt-20261026-abc", model: "doubao-seedance-2-0-mini-250828", prompt: "方舟那一发" });
    calls.length = 0;

    const mm = await list(u).expect(200);
    expect(mm.body.ok).toBe(true);
    expect(mm.body.tasks.map((t) => t.taskId)).toEqual(["100000000000001"]);
    expect(mm.body.tasks[0]).toMatchObject({
      api: "v2",
      model: LITE,
      durationSec: 5,
      ratio: "9:16",
      resolution: "480P",
      prompt: "海边，女孩回头一笑",
      costTokens: 56_000,
    });
    expect(Date.parse(mm.body.tasks[0].createdAt)).toBeGreaterThan(Date.now() - 60_000);

    const ark = await request(app).get("/api/ark/video-tasks").set(u.auth).expect(200);
    expect(ark.body.tasks.map((t) => t.taskId)).toEqual(["cgt-20261026-abc"]);
    expect(calls).toHaveLength(0);
  });

  test("已经因为失败退了钱的不列（没有成片可取了）；24 小时之前的不列", async () => {
    const u = await registerUser("hide");
    for (const id of ["111", "222", "333"]) {
      createReply = () => resp(200, { task_id: id });
      await post(u).expect(200);
    }
    await GenTaskCharge.updateOne({ provider: "minimax", taskId: "111" }, { $set: { state: "refunded" } });
    await ArkVideoTask.collection.updateOne({ taskId: "222" }, { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const res = await list(u).expect(200);
    expect(res.body.tasks.map((t) => t.taskId)).toEqual(["333"]);
  });

  test("V2 没开（走中国站）→ 空表：列出来 App 去问 /v2/video/:id 只会拿回 501（任务绑站）", async () => {
    const u = await registerUser("cnlist");
    await post(u).expect(200);
    delete process.env.MINIMAX_INTL_API_KEY;
    process.env.MINIMAX_API_KEY = "mm-cn-test";
    const res = await list(u).expect(200);
    expect(res.body).toEqual({ ok: true, tasks: [] });
  });

  test("登记落库失败只吼不抛：照样 200 + task_id、钱照扣（任务已受理，5xx 会让 App 以为没受理去重试 = 再花一次钱）", async () => {
    const u = await registerUser("regfail");
    const before = await balance(u.id);
    const create = jest.spyOn(ArkVideoTask, "create").mockRejectedValueOnce(new Error("mongo down"));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post(u);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, task_id: "100000000000001" });
      expect(before - (await balance(u.id))).toBe(56_000);
      expect(err.mock.calls.some((c) => /视频任务登记落库失败 task=100000000000001/.test(String(c[0])))).toBe(true);
    } finally {
      create.mockRestore();
      err.mockRestore();
    }
  });

  test("未登录 → 401", async () => {
    await request(app).get("/api/minimax/video-tasks").expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("查询：只给任务的主人看；失败按原桶退回（恰好一次）", () => {
  /** 建一发（真的走路由），回 { u, id } */
  async function created(tag, id = "100000000000001") {
    createReply = () => resp(200, { task_id: id });
    const u = await registerUser(tag);
    const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    expect(res.status).toBe(200);
    calls.length = 0;
    return { u, id };
  }
  const poll = (u, id) => request(app).get(`/api/minimax/v2/video/${id}`).set(u.auth);
  const task = (id, o) => ({ task: { id, model: LITE, created_at: 1, updated_at: 2, resolution: "480P", duration: 5, ratio: "9:16", task_type: "generation", ...o } });

  test("还在跑：200 { status: running }，没有 url；打的是 /v2/query/video_generation/{id}", async () => {
    const { u, id } = await created("run");
    const res = await poll(u, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, taskId: id, status: "running" });
    expect(res.body.url).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([`${V2}/query/video_generation/${id}`]);
    expect(calls[0].headers.Authorization).toBe("Bearer mm-intl-test-not-real");
  });

  test("出成了：带 url / usage / 画幅，账结成 settled（钱照收）；用量与实扣对得上就不吼", async () => {
    const { u, id } = await created("ok");
    queryReplies[id] = () =>
      resp(200, task(id, { status: "succeeded", content: { url: CDN }, usage: { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 0, total_tokens: 1 } }));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const before = await balance(u.id);
      const res = await poll(u, id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        taskId: id,
        status: "succeeded",
        url: CDN,
        usage: { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 0 },
        duration: 5,
        ratio: "9:16",
        resolution: "480P",
      });
      expect(await balance(u.id)).toBe(before);
      expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("settled");
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test("出成了、但上游按的秒数与我们收的对不上 → 吼一行「计费对不上」（只吼不拦）", async () => {
    const { u, id } = await created("mismatch");
    queryReplies[id] = () => resp(200, task(id, { status: "succeeded", content: { url: CDN }, usage: { total_seconds: 15 } }));
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await poll(u, id);
      expect(res.status).toBe(200);
      expect(err.mock.calls.map((c) => String(c[0])).some((s) => /计费对不上.*15 秒.*168000.*56000/.test(s))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test.each(["failed", "cancelled"])("%s：退回实扣（按原桶）、带 refund 与余额头、一行 provider_failed；再问一次不再退", async (st) => {
    const { u, id } = await created(`fail_${st}`);
    const after = await balance(u.id);
    queryReplies[id] = () => resp(200, task(id, { status: st, error: { code: "1027", message: "output sensitive" }, usage: {} }));
    const res = await poll(u, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: st, error: { code: "1027", message: "output sensitive" }, refund: { state: "refunded", tokens: 56_000 } });
    expect(res.body.url).toBeUndefined();
    expect(Number(res.headers["x-wallet-plan"]) + Number(res.headers["x-wallet-addon"])).toBe(after + 56_000);
    expect(await balance(u.id)).toBe(after + 56_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed", memo: taskRefund.memoOf("minimax", id) })).toBe(1);
    const again = await poll(u, id);
    expect(again.body.refund).toMatchObject({ state: "refunded" });
    expect(await balance(u.id)).toBe(after + 56_000);
    expect(await TokenLedger.countDocuments({ user: u.id, reason: "provider_failed" })).toBe(1);
  });

  test("开关 MINIMAX_FAIL_REFUND=off：failed 不退，账留 open（refund 说 pending）", async () => {
    const { u, id } = await created("off");
    process.env.MINIMAX_FAIL_REFUND = "off";
    const after = await balance(u.id);
    queryReplies[id] = () => resp(200, task(id, { status: "failed", error: { code: "1027", message: "x" } }));
    const res = await poll(u, id);
    expect(res.body.refund).toMatchObject({ state: "pending" });
    expect(await balance(u.id)).toBe(after);
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("open");
  });

  // 2026-10-26 文档审核：开关关着时 settleTask 原来一个字都不写，失败的那几发照样 open —— 两道并发闸数的正是 open，
  // 于是 4 发审核没过的失败就把这个人关在 H3 门外半小时（「等其中一段出来再点」，而那几段永远不会出来）；全站 25 发就是海外所有人都忙。
  test("开关 off：用户自己问到的失败不再算在跑 —— 不占按人 / 全站两道并发闸；账仍 open，开关打开后照常退", async () => {
    process.env.MINIMAX_FAIL_REFUND = "off";
    const u = await registerUser("offslot");
    const post = () => request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
    const ids = ["61001", "61002", "61003", "61004"];
    for (const id of ids) {
      createReply = () => resp(200, { task_id: id });
      expect((await post()).status).toBe(200);
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createReply = () => resp(200, { task_id: "61005" });
      // 4 发都还在跑：第 5 发被按人那一道拦下
      expect((await post()).body.code).toBe("IN_FLIGHT_LIMIT");
      // 4 发都没过 MiniMax 的审核，他自己问到了
      for (const id of ids) {
        queryReplies[id] = () => resp(200, task(id, { status: "failed", error: { code: "1027", message: "output sensitive" } }));
        expect((await poll(u, id)).body.refund).toMatchObject({ state: "pending" });
      }
    } finally {
      warn.mockRestore();
    }
    const rows = await GenTaskCharge.find({ taskId: { $in: ids } }).lean();
    expect(rows.map((r) => [r.state, r.upstreamStatus, r.upstreamCode])).toEqual(ids.map(() => ["open", "failed", "1027"]));
    const since = new Date(Date.now() - 60_000);
    expect(await taskRefund.minimaxV2InFlightOfUser({ since, user: u.id })).toBe(0);
    expect(await taskRefund.minimaxV2InFlight({ since })).toBe(0);
    expect((await post()).status).toBe(200);
    // 对照：cancelled 同样不算；还在跑的照算
    queryReplies["61005"] = () => resp(200, task("61005", { status: "cancelled" }));
    await poll(u, "61005");
    createReply = () => resp(200, { task_id: "61006" });
    expect((await post()).status).toBe(200);
    expect(await taskRefund.minimaxV2InFlightOfUser({ since, user: u.id })).toBe(1);
    // 开关打开：那几行还是 open，照常被抢成 claimed、退回
    delete process.env.MINIMAX_FAIL_REFUND;
    const before = await balance(u.id);
    expect((await poll(u, "61001")).body.refund).toMatchObject({ state: "refunded", tokens: 56_000 });
    expect(await balance(u.id)).toBe(before + 56_000);
  });

  // 2026-10-26 文档审核：H3 的查询只给主人看，而真人档（v1）的查询照 2026-10-07 的口径不查归属；两版的任务号在 MiniMax 那边是同一个命名空间 ——
  // v1 认不认 H3 的号没验过（要真打上游），按认处理：不拦的话 v1 那条就是 H3 成片的另一条路。
  test("真人档（v1）的查询认得出账上记着是 H3 的任务号 → 404（谁问都是）、不出网；真人档的号与没有账的号照旧问 v1", async () => {
    const { u, id } = await created("v1side");
    const other = await registerUser("v1side2");
    for (const who of [other, u]) {
      const res = await request(app).get(`/api/minimax/video/${id}`).set(who.auth);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
      // 不说「这个号是 H3 的」：对不是主人的人，那也是一句「这个号存在」
      expect(res.body.message).not.toMatch(/H3/);
    }
    expect(calls).toHaveLength(0);
    await GenTaskCharge.create({ provider: "minimax", taskId: "778", kind: "minimax", user: u.id, charged: 85_000, took: { plan: 85_000, addon: 0 }, region: "intl" });
    for (const v1id of ["778", "779"]) {
      fetchSpy.mockImplementationOnce(async (url) => {
        calls.push({ url: String(url) });
        return resp(200, { task_id: v1id, status: "Processing", base_resp: { status_code: 0, status_msg: "success" } });
      });
      const r = await request(app).get(`/api/minimax/video/${v1id}`).set(other.auth);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("Processing");
    }
    expect(calls.map((c) => c.url)).toEqual(["https://api.minimax.io/v1/query/video_generation?task_id=778", "https://api.minimax.io/v1/query/video_generation?task_id=779"]);
  });

  test("别人问我的任务 → 404 TASK_NOT_FOUND（不说有没有），不出网、不退钱", async () => {
    const { id } = await created("owner");
    const other = await registerUser("other");
    queryReplies[id] = () => resp(200, task(id, { status: "failed", error: { code: "1027", message: "x" } }));
    const res = await poll(other, id);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TASK_NOT_FOUND");
    expect(calls).toHaveLength(0);
    expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("open");
  });

  test("管理员可以查别人的任务（排查用）；退款照旧退给账的主人、refund 不给管理员", async () => {
    const { u, id } = await created("own2");
    const admin = await registerUser("admin");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const after = await balance(u.id);
    queryReplies[id] = () => resp(200, task(id, { status: "failed", error: { code: "1027", message: "x" } }));
    const res = await poll(admin, id);
    expect(res.status).toBe(200);
    expect(res.body.refund).toBeUndefined();
    expect(await balance(u.id)).toBe(after + 56_000);
  });

  test("真人档（v1）的任务号拿来问 V2 → 404，不出网", async () => {
    const u = await registerUser("v1row");
    await GenTaskCharge.create({ provider: "minimax", taskId: "777", kind: "minimax", user: u.id, charged: 85_000, took: { plan: 85_000, addon: 0 }, region: "intl" });
    const res = await poll(u, "777");
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  // 2026-10-26 终审：原来「没有账就照常放行」—— 删号级联把账与登记都删掉之后，那个人的 H3 任务在上游还查得到 7 天，挨个猜号就拿得到成片地址。
  // 现在账上没有 H3 那一行时看取回登记：登记是这个人的才放行（落账失败、登记落上了的那个主人自己还取得回）。
  test("账上没有 H3 的那一行、登记是自己的（落账失败过）→ 照常查、吼一次；登记是别人的 / 两样都没有 → 404、不出网", async () => {
    const u = await registerUser("norow");
    const other = await registerUser("norow2");
    await ArkVideoTask.create({ userId: u.id, taskId: "123450", provider: "minimax", api: "v2", model: LITE });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await poll(u, "123450")).status).toBe(200);
      expect((await poll(u, "123450")).status).toBe(200);
      expect(warn.mock.calls.filter((c) => /task=123450 没有 H3 的账/.test(String(c[0])))).toHaveLength(1);
      calls.length = 0;
      // 登记是 u 的：别人问 → 404（不说有没有）
      const res = await poll(other, "123450");
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("TASK_NOT_FOUND");
      // 两样都没有的号（从没经过这台服务器 / 已被删号级联清掉）→ 404，谁问都是
      expect((await poll(u, "123451")).status).toBe(404);
      // 登记上的 provider / api 不对（方舟那一半的登记）不算
      await ArkVideoTask.create({ userId: u.id, taskId: "cgt-123452", model: "doubao-seedance-2-0-mini-260615" });
      expect((await poll(u, "cgt-123452")).status).toBe(404);
      expect(calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("删号之后（账与登记都被级联删掉）：猜号的人一律 404、不出网；管理员排查照常查", async () => {
    const { u, id } = await created("purged");
    // branchAdmin.purgeUserCascade 删的就是这两张表里这个人的行
    await GenTaskCharge.deleteMany({ user: u.id });
    await ArkVideoTask.deleteMany({ userId: u.id });
    queryReplies[id] = () => resp(200, task(id, { status: "succeeded", content: { url: CDN } }));
    const guesser = await registerUser("guesser");
    const res = await poll(guesser, id);
    expect(res.status).toBe(404);
    expect(res.body.url).toBeUndefined();
    expect(calls).toHaveLength(0);
    const admin = await registerUser("admin_purged");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = await poll(admin, id);
      expect(a.status).toBe(200);
      expect(a.body.url).toBe(CDN);
    } finally {
      warn.mockRestore();
    }
  });

  // 唯一索引是 (provider, taskId)，而 MiniMax 两个站、两版接口的号都是数字串：切站之前中国站建过的真人档老号与国际站新建的 H3 撞上时，
  // 这一发的钱记不进账（recordCharge 回的是库里那一行老账）。原来零报错，而且轮询只认得那一行老账（不是 H3）→ 真正的主人永远 404。
  test("任务号撞上同号的老账（切站之前中国站的真人档）：照常受理、落账时吼「撞上了另一笔账」；主人凭登记照样取得回成片，老账一分不动", async () => {
    const oldOwner = await registerUser("collide_old");
    await GenTaskCharge.create({ provider: "minimax", taskId: "424242", kind: "minimax", user: oldOwner.id, charged: 85_000, took: { plan: 85_000, addon: 0 }, region: "cn" });
    createReply = () => resp(200, { task_id: "424242" });
    const u = await registerUser("collide_new");
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await request(app).post("/api/minimax/v2/video").set(u.auth).send(liteBody());
      expect(res.status).toBe(200);
      expect(res.body.task_id).toBe("424242");
      expect(err.mock.calls.map((c) => String(c[0])).some((s) => /撞上了另一笔账 minimax task=424242/.test(s))).toBe(true);
      // 主人：账上没有 H3 那一行，登记是他的 → 照常查；上游说失败也动不了那一行老账（settleTask 按 api 圈定）
      queryReplies["424242"] = () => resp(200, task("424242", { status: "failed", error: { code: "1027", message: "x" } }));
      calls.length = 0;
      const mine = await poll(u, "424242");
      expect(mine.status).toBe(200);
      expect(mine.body.status).toBe("failed");
      expect(mine.body.refund).toBeUndefined();
      expect((await GenTaskCharge.findOne({ taskId: "424242" }).lean()).state).toBe("open");
      // 老账的主人问 V2：那一行不是 H3 的账、他也没有 H3 的登记 → 404
      calls.length = 0;
      expect((await poll(oldOwner, "424242")).status).toBe(404);
      expect(calls).toHaveLength(0);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });

  test.each([
    ["400 查无此任务（超过 7 天）", () => oaiError(400, "bad_request_error", "invalid task_id (2013)"), 404, "TASK_NOT_FOUND"],
    ["401 我们的 key 坏了 —— 不能原样回去（App 会当成登录过期）", () => oaiError(401, "authorized_error", "login fail (1004)"), 502, "UPSTREAM_ERROR"],
    ["429", () => oaiError(429, "rate_limit_error", "rate limit (1002)"), 503, "UPSTREAM_BUSY"],
    ["回包读不懂", () => resp(200, "<html>"), 502, "UPSTREAM_ERROR"],
    [
      "连不上",
      () => {
        throw new Error("boom");
      },
      504,
      "UPSTREAM_TIMEOUT",
    ],
  ])("上游 %s → %s %s，不是结局：账不动、钱不动", async (_l, reply, status, code) => {
    const { u, id } = await created(`q${status}`);
    queryReplies[id] = reply;
    const after = await balance(u.id);
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await poll(u, id);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, code });
      expect((await GenTaskCharge.findOne({ taskId: id }).lean()).state).toBe("open");
      expect(await balance(u.id)).toBe(after);
    } finally {
      err.mockRestore();
    }
  });

  test("任务号只收安全字符（不许把路径拼进上游 URL）", async () => {
    const u = await registerUser("badid");
    const res = await request(app).get("/api/minimax/v2/video/..%2F..%2Ffiles").set(u.auth);
    expect([400, 404]).toContain(res.status);
    expect(calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("失败退款的判据与清扫器：V2 有自己的一支（2026-10-26 设计审核：原来只认 v1，H3 失败永远不退）", () => {
  test("verdictOf：V2 认小写 succeeded / failed / cancelled；v1 的 Fail / Success 与 V2 互不相认；V2 没有 expired", () => {
    const { verdictOf } = taskRefund;
    expect(verdictOf("minimax", "succeeded", "v2")).toBe("succeeded");
    expect(verdictOf("minimax", "failed", "v2")).toBe("failed");
    expect(verdictOf("minimax", "cancelled", "v2")).toBe("failed");
    for (const s of ["queued", "running", "expired", "Fail", "Success", "", undefined]) expect(verdictOf("minimax", s, "v2")).toBeNull();
    // v1 不变：认 Fail / Success，不认小写
    expect(verdictOf("minimax", "Fail")).toBe("failed");
    expect(verdictOf("minimax", "Success")).toBe("succeeded");
    expect(verdictOf("minimax", "failed")).toBeNull();
    expect(verdictOf("minimax", "succeeded")).toBeNull();
  });

  test("settleTask 只结同一版接口建的账：v1 的 Fail 结不了 H3 的账，V2 的 failed 结不了真人档的账", async () => {
    const u = await registerUser("scope");
    const base = { provider: "minimax", kind: "video", user: u.id, charged: 56_000, took: { plan: 56_000, addon: 0 }, region: "intl" };
    await GenTaskCharge.create({ ...base, taskId: "v2row", api: "v2" });
    await GenTaskCharge.create({ ...base, taskId: "v1row", kind: "minimax" });
    expect(await taskRefund.settleTask({ provider: "minimax", taskId: "v2row", status: "Fail", region: "intl" })).toBeNull();
    const v2asv1 = await taskRefund.settleTask({ provider: "minimax", taskId: "v1row", status: "failed", region: "intl", api: "v2" });
    expect(v2asv1).toBeNull();
    expect((await GenTaskCharge.findOne({ taskId: "v2row" }).lean()).state).toBe("open");
    expect((await GenTaskCharge.findOne({ taskId: "v1row" }).lean()).state).toBe("open");
    // 对照：各自那一版的结论照常结
    await taskRefund.settleTask({ provider: "minimax", taskId: "v2row", status: "failed", region: "intl", api: "v2" });
    await taskRefund.settleTask({ provider: "minimax", taskId: "v1row", status: "Fail", region: "intl" });
    expect((await GenTaskCharge.findOne({ taskId: "v2row" }).lean()).state).toBe("refunded");
    expect((await GenTaskCharge.findOne({ taskId: "v1row" }).lean()).state).toBe("refunded");
  });

  test("recordCharge 把 api:v2 落进库（mongoose strict 会悄悄丢掉 schema 里没有的键 —— 这一条钉的就是那一位还在）", async () => {
    const u = await registerUser("rec");
    const row = await taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: "8888", kind: "video", user: u.id, cost: 1, took: { plan: 1, addon: 0 }, region: "intl" });
    expect(row.api).toBe("v2");
    const v1 = await taskRefund.recordCharge({ provider: "minimax", taskId: "8889", kind: "minimax", user: u.id, cost: 1, took: { plan: 1, addon: 0 }, region: "intl" });
    expect(v1.api).toBeUndefined();
  });

  test("recordCharge 撞上唯一索引：同一笔重放不吼；库里那一行是别人的 / 另一版接口的 / 另一个站的 → 吼「撞上了另一笔账」，回库里那一行、不改它", async () => {
    const u = await registerUser("dup");
    const other = await registerUser("dup2");
    const rec = (o) => taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: "9090", kind: "video", user: u.id, cost: 1, took: { plan: 1, addon: 0 }, region: "intl", ...o });
    await rec({});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await rec({})).user.toString()).toBe(String(u.id));
      expect(err).not.toHaveBeenCalled();
      for (const o of [{ user: other.id }, { api: undefined, kind: "minimax" }, { region: "cn" }]) {
        err.mockClear();
        const row = await rec(o);
        expect(row).toMatchObject({ taskId: "9090", api: "v2", region: "intl" });
        expect(String(row.user)).toBe(String(u.id));
        expect(err.mock.calls.map((c) => String(c[0])).some((s) => /撞上了另一笔账 minimax task=9090/.test(s))).toBe(true);
      }
    } finally {
      err.mockRestore();
    }
    expect(await GenTaskCharge.countDocuments({ taskId: "9090" })).toBe(1);
  });

  test("清扫器：没人再来问的 H3 失败任务 → 问 V2 查询端点（不是 v1 的）→ 退钱、发一条通知", async () => {
    const u = await registerUser("sweep");
    await taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: "5551", kind: "video", user: u.id, cost: 56_000, took: { plan: 56_000, addon: 0 }, region: "intl" });
    await GenTaskCharge.updateOne({ taskId: "5551" }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    queryReplies["5551"] = () => resp(200, { task: { id: "5551", status: "failed", error: { code: "1027", message: "x" } } });
    const before = await balance(u.id);
    const out = await taskRefund.sweepTaskRefunds();
    expect(out).toMatchObject({ checked: 1, settled: 1 });
    expect(calls.map((c) => c.url)).toEqual([`${V2}/query/video_generation/5551`]);
    expect(await balance(u.id)).toBe(before + 56_000);
    const row = await GenTaskCharge.findOne({ taskId: "5551" }).lean();
    expect(row).toMatchObject({ state: "refunded", upstreamStatus: "failed", upstreamCode: "1027" });
    const Notification = require("../src/models/Notification");
    expect(await Notification.countDocuments({ type: taskRefund.NOTIFY_TYPE })).toBeGreaterThanOrEqual(1);
  });

  test("清扫器：V2 查询回 400（查无此任务）/ 还在跑 → 不是结局，退避，不退钱", async () => {
    const u = await registerUser("sweep2");
    for (const id of ["5552", "5553"]) {
      await taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: id, kind: "video", user: u.id, cost: 56_000, took: { plan: 56_000, addon: 0 }, region: "intl" });
    }
    await GenTaskCharge.updateMany({}, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    queryReplies["5552"] = () => oaiError(400, "bad_request_error", "invalid task_id (2013)");
    queryReplies["5553"] = () => resp(200, { task: { id: "5553", status: "running" } });
    const before = await balance(u.id);
    const out = await taskRefund.sweepTaskRefunds();
    expect(out).toMatchObject({ checked: 2, settled: 0 });
    expect(await balance(u.id)).toBe(before);
    expect(await GenTaskCharge.countDocuments({ state: "open", checks: 1 })).toBe(2);
  });

  test("清扫器：区域切到中国站之后不去问（任务绑站；中国站也没有 V2）", async () => {
    const u = await registerUser("sweep3");
    await taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: "5554", kind: "video", user: u.id, cost: 56_000, took: { plan: 56_000, addon: 0 }, region: "intl" });
    await GenTaskCharge.updateOne({ taskId: "5554" }, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    delete process.env.MINIMAX_INTL_API_KEY;
    process.env.MINIMAX_API_KEY = "mm-cn-test";
    await taskRefund.sweepTaskRefunds();
    expect(calls).toHaveLength(0);
    expect((await GenTaskCharge.findOne({ taskId: "5554" }).lean()).state).toBe("open");
  });

  // 2026-10-26 终审：H3 只查得到受理之后 7 天内的任务。开关关着时用户自己问到的失败只记在账上（upstreamStatus）、钱不动；
  // 原来开关打开之后清扫器每一行都回去问 —— 第 8 天问只会查无此任务（不是结局），最后记成 lost，用户亲眼看见失败的那几发也退不了。
  test("开关 off 期间用户自己问到的失败：开关打开之后清扫器按记下的那句直接退（不再回去问，第 7 天之后上游已经查不到）；没人问过的照旧回去问", async () => {
    const u = await registerUser("known");
    for (const id of ["6661", "6662"]) {
      await taskRefund.recordCharge({ provider: "minimax", api: "v2", taskId: id, kind: "video", user: u.id, cost: 56_000, took: { plan: 56_000, addon: 0 }, region: "intl" });
    }
    process.env.MINIMAX_FAIL_REFUND = "off";
    await taskRefund.settleTask({ provider: "minimax", taskId: "6661", status: "failed", code: "1027", viewerId: u.id, region: "intl", api: "v2" });
    expect(await GenTaskCharge.findOne({ taskId: "6661" }).lean()).toMatchObject({ state: "open", upstreamStatus: "failed", upstreamCode: "1027" });
    const later = new Date(Date.now() + 7.5 * 24 * 3600 * 1000); // 受理之后 7.5 天：上游已经查不到这两发了
    const query = jest.fn(async () => null);
    // 开关还关着：不按记下的那句结（照旧问、问不到、退避）
    await taskRefund.reconcile({ now: later, query });
    expect((await GenTaskCharge.findOne({ taskId: "6661" }).lean()).state).toBe("open");
    expect(query).toHaveBeenCalledTimes(2);
    // 开关打开
    delete process.env.MINIMAX_FAIL_REFUND;
    query.mockClear();
    await GenTaskCharge.updateMany({}, { $set: { nextCheckAt: new Date(Date.now() - 1000) } });
    const before = await balance(u.id);
    const out = await taskRefund.reconcile({ now: later, query });
    expect(out).toMatchObject({ checked: 1, settled: 1, lost: 0 });
    expect(query.mock.calls.map((c) => c[0].taskId)).toEqual(["6662"]);
    expect(await GenTaskCharge.findOne({ taskId: "6661" }).lean()).toMatchObject({ state: "refunded", upstreamStatus: "failed", upstreamCode: "1027" });
    expect(await balance(u.id)).toBe(before + 56_000);
    expect((await GenTaskCharge.findOne({ taskId: "6662" }).lean()).state).toBe("open");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("成片主机：产物代理与转存认 H3 的 CDN（只认那一个主机）", () => {
  test("isUpstreamTempVideoUrl：方舟 + H3 的 CDN；minimax.io 的别的子域、http、带端口都不算", () => {
    const { isUpstreamTempVideoUrl } = require("../src/services/videoAsset.service");
    expect(isUpstreamTempVideoUrl(CDN)).toBe(true);
    expect(isUpstreamTempVideoUrl("https://ark-content.tos-cn-beijing.volces.com/a.mp4")).toBe(true);
    for (const bad of [
      "http://video-product.cdn.minimax.io/a.mp4",
      "https://video-product.cdn.minimax.io:8443/a.mp4",
      "https://evil.cdn.minimax.io/a.mp4",
      "https://api.minimax.io/v2/x.mp4",
      "https://video-product.cdn.minimax.io.evil.com/a.mp4",
      "https://res.cloudinary.com/x/video/upload/a.mp4",
      "",
      null,
    ]) {
      expect([bad, isUpstreamTempVideoUrl(bad)]).toEqual([bad, false]);
    }
  });

  test("GET /api/ark/asset 放行 H3 的 CDN、拒别的子域；带端口 / 带账号密码的写法也拒（与转存同一个判据，2026-10-26 终审）", async () => {
    const u = await registerUser("asset");
    const ok = await request(app).get("/api/ark/asset").query({ url: CDN }).set(u.auth);
    expect(ok.status).toBe(200);
    expect(ok.text || ok.body.toString()).toBe("mp4-bytes");
    for (const bad of [
      "https://evil.cdn.minimax.io/a.mp4",
      "https://video-product.cdn.minimax.io:8443/a.mp4",
      "https://u:p@video-product.cdn.minimax.io/a.mp4",
      "https://u@video-product.cdn.minimax.io/a.mp4",
      "http://video-product.cdn.minimax.io/a.mp4",
    ]) {
      const res = await request(app).get("/api/ark/asset").query({ url: bad }).set(u.auth);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    expect(callsTo("https://video-product.cdn.minimax.io")).toHaveLength(1);
  });

  test("POST /api/ark/transfer-video（受理式）收 H3 的成片、拒别的子域", async () => {
    const arkTransfer = require("../src/services/arkTransfer.service");
    const spy = jest.spyOn(arkTransfer, "requestTransfer").mockResolvedValue({ state: "pending" });
    try {
      const u = await registerUser("transfer");
      const ok = await request(app).post("/api/ark/transfer-video").set(u.auth).send({ url: CDN, wait: false });
      expect(ok.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(CDN, expect.anything());
      const bad = await request(app).post("/api/ark/transfer-video").set(u.auth).send({ url: "https://evil.cdn.minimax.io/a.mp4", wait: false });
      expect(bad.status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });
});
