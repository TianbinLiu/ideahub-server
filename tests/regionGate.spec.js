// tests/regionGate.spec.js
// 覆盖：出片地区门禁接在钱上的那一处 —— services/arkGateway.regionGate（off / observe / on 的执行）与 chargedArkCall 里的挂点，
// 经真的 app.js 走 /api/ark 与 /api/minimax 两条出片路，再加「只读的轮询 / 取件 / 查询一律不拦」。
// 白模化的前置预检（看帧之前）在 tests/branchTemplate.spec.js「白模化两阶段」那一组里。
//
// 主人原话（2026-10-26）：美国境内不能用 Seedance、只能用 MiniMax 国际版；中国境内 IP 可以选；海外由于政策原因只能用 MiniMax。
//
// ★ 不花钱、不出网：fetch 换成间谍，按 URL 回假的上游回包（方舟 / MiniMax）；「没出网」由间谍断言，不靠推理。
// ★ 地区靠 cf-ipcountry 头造（utils/geo.countryOf 的第一级来源）。supertest 不带这个头时 IP 是 127.0.0.1 → geoip 查不到 → 境外，
//   所以「境内」的用例一律显式带 `cf-ipcountry: CN`。
// ★ 这一组判据漏了都**零症状**：门禁挂在扣钱之后 = 被拦的人照样被扣钱；observe 当成 on = 缺省配置下海外整批出不了片；
//   轮询也拦 = 已经付过钱的在途任务取不回来。所以每一条都有反例。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const fs = require("fs");
const path = require("path");

let mongod;
let app;
let wallet;
let gateway;
let videoRegion;
let User;
let TokenLedger;
let ArkVideoTask;
let GenTaskCharge;
let fetchSpy;
let warnSpy;
/** 出网记录：{ url, method } */
let calls;
let taskSeq = 0;

const ARK = "https://ark.cn-beijing.volces.com/api/v3";
const MINI = "doubao-seedance-2-0-mini-260615";
const CHAT = "doubao-seed-2-1-turbo-260628";
const IMAGE = "doubao-seedream-4-0-20260415";
const MM_MODEL = "MiniMax-Hailuo-2.3-Fast";

/** 高清档（2.0 mini · 720p）的一段普通片：付费用户能出；免费用户会被套餐门禁拒 */
const hdTask = () => ({ model: MINI, content: [{ type: "text", text: "海边" }], duration: 5, resolution: "720p", ratio: "9:16" });

/** 这些 env 每条用例都从干净的开始（门禁与地区全是现读 env；FREE_VIDEO_GATE 决定真人档对免费用户开不开，拒绝话跟着它挑句子） */
const ENV_KEYS = ["VIDEO_REGION_GATE", "VIDEO_ZONE_FORCE", "MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY", "MINIMAX_REGION", "FREE_VIDEO_GATE"];
let savedEnv;

async function registerUser(tag, { plan = "std" } = {}) {
  const name = `rg_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  const id = res.body.user._id;
  if (plan) await wallet.buyPlan(id, plan);
  return { id, auth: { Authorization: `Bearer ${res.body.token}` }, doc: () => User.findById(id).lean() };
}

const balance = async (id) => {
  const w = await wallet.getWallet(id);
  return w.plan + w.addon;
};

/** 地区头：境内 / 境外（美国） */
const CN = { "cf-ipcountry": "CN" };
const US = { "cf-ipcountry": "US" };

/** 日志里 `[region] …` 那几行 */
const regionLines = () => warnSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith("[region]"));

const resp = (status, obj) => ({ status, text: async () => JSON.stringify(obj) });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  wallet = require("../src/services/tokenWallet.service");
  gateway = require("../src/services/arkGateway.service");
  videoRegion = require("../src/config/videoRegion");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  ArkVideoTask = require("../src/models/ArkVideoTask");
  GenTaskCharge = require("../src/models/GenTaskCharge");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  // 每日 token 上限（config/tokens.DAILY_LIMITS）按当天流水算：每条用例清一次，别让后面的用例撞 429
  await TokenLedger.deleteMany({});
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ARK_API_KEY = "test-key-not-real";
  calls = [];
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET" });
    if (u === `${ARK}/contents/generations/tasks`) {
      taskSeq += 1;
      return resp(200, { id: `cgt-region-${taskSeq}` });
    }
    if (u.startsWith(`${ARK}/contents/generations/tasks/`)) return resp(200, { id: u.slice(u.lastIndexOf("/") + 1), status: "running" });
    if (u === `${ARK}/chat/completions`) return resp(200, { choices: [{ message: { content: "好" } }] });
    if (u === `${ARK}/images/generations`) return resp(200, { data: [{ url: "https://x.volces.com/1.jpeg" }] });
    if (/\/v1\/video_generation$/.test(u)) return resp(200, { task_id: "mm-region-1", base_resp: { status_code: 0, status_msg: "success" } });
    if (/\/v1\/query\/video_generation\?task_id=/.test(u)) {
      return resp(200, { task_id: "mm-region-1", status: "Processing", base_resp: { status_code: 0, status_msg: "success" } });
    }
    throw new Error(`测试里没有为这个地址准备回应：${u}`);
  });
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  delete process.env.ARK_API_KEY;
});

// ─────────────────────────────────────────────────────────────────────
describe("门禁 on：海外的 Seedance 出片在扣钱之前回 403、一分钱不动", () => {
  beforeEach(() => {
    process.env.VIDEO_REGION_GATE = "on";
  });

  test("境外（美国）→ 403 REGION_UNAVAILABLE + billed:false；余额、流水、任务登记、退款底账一样都没动；不出网；不写钱包头", async () => {
    const u = await registerUser("on_us");
    const before = await balance(u.id);
    const ledgerBefore = await TokenLedger.countDocuments({ user: u.id });

    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask());

    expect(res.status).toBe(403);
    // 回包只有这几个键：billed:false 是「这一发没扣钱」的明说（老 App 只读 message，新 App 认 code）
    expect(Object.keys(res.body).sort()).toEqual(["billed", "code", "message", "ok", "providers", "reason", "zone"]);
    expect(res.body).toMatchObject({ ok: false, code: "REGION_UNAVAILABLE", reason: "region", zone: "intl", billed: false });
    expect(res.body.message).toMatch(/not charged/);
    expect(res.body.message).toMatch(/没有扣费/);
    expect(await balance(u.id)).toBe(before);
    expect(await TokenLedger.countDocuments({ user: u.id })).toBe(ledgerBefore);
    expect(await ArkVideoTask.countDocuments({ userId: u.id })).toBe(0);
    expect(await GenTaskCharge.countDocuments({ user: u.id })).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // 余额没变 = 不写钱包头（与「不在册」那一路同一个口径：写了只会让 App 的镜像多刷一次）
    expect(res.headers["x-wallet-plan"]).toBeUndefined();
    // 拦了要响：一行 deny，带位置 / 模型 / 地区 / 国家 / 来源 / 谁
    const lines = regionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[region\] deny at=\/contents\/generations\/tasks task doubao-seedance-2-0-mini-260615 zone=intl country=US source=cf /);
    expect(lines[0]).toContain(`user=${u.id}`);
  });

  test("境内（CN）→ 照常受理、按价扣钱（门禁只拦海外）", async () => {
    const u = await registerUser("on_cn");
    const before = await balance(u.id);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(CN).send(hdTask());
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^cgt-region-/);
    expect(await balance(u.id)).toBeLessThan(before);
    expect(calls.filter((c) => c.url === `${ARK}/contents/generations/tasks`)).toHaveLength(1);
    expect(regionLines()).toEqual([]);
  });

  test("港澳台 / 判不出国家（cf 头 XX、本机 IP）都按境外拦", async () => {
    const u = await registerUser("on_hk");
    for (const headers of [{ "cf-ipcountry": "HK" }, { "cf-ipcountry": "TW" }, { "cf-ipcountry": "XX" }, {}]) {
      const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(headers).send(hdTask());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("REGION_UNAVAILABLE");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("★ 地区先于套餐门禁：海外的免费用户点高清，听到的是「地区不提供」而不是「去升级」（付了钱回来还是被拒）", async () => {
    const free = await registerUser("on_free", { plan: null });
    const us = await request(app).post("/api/ark/contents/generations/tasks").set(free.auth).set(US).send(hdTask());
    expect(us.status).toBe(403);
    expect(us.body.code).toBe("REGION_UNAVAILABLE");
    // 境内的同一个人照旧是套餐门禁那一句（顺序只改了海外）
    const cn = await request(app).post("/api/ark/contents/generations/tasks").set(free.auth).set(CN).send(hdTask());
    expect(cn.status).toBe(403);
    expect(cn.body.code).toBe("PLAN_REQUIRED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("管理员不豁免：这是地区政策，不是计费（免单那道是另一件事）", async () => {
    const admin = await registerUser("on_admin");
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(admin.auth).set(US).send(hdTask());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REGION_UNAVAILABLE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("出图、对话不归这道闸管：海外照常（范围等主人拍板）", async () => {
    const u = await registerUser("on_other");
    await request(app).post("/api/ark/images/generations").set(u.auth).set(US).send({ model: IMAGE, prompt: "x" }).expect(200);
    await request(app).post("/api/ark/chat/completions").set(u.auth).set(US).send({ model: CHAT, messages: [] }).expect(200);
    expect(calls.map((c) => c.url)).toEqual([`${ARK}/images/generations`, `${ARK}/chat/completions`]);
    expect(regionLines()).toEqual([]);
  });

  test("开发用的 VIDEO_ZONE_FORCE=cn：美国的请求也按境内放行（日志里那一行照实报 country=US）", async () => {
    process.env.VIDEO_ZONE_FORCE = "cn";
    const u = await registerUser("on_force");
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask()).expect(200);
    process.env.VIDEO_ZONE_FORCE = "intl";
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(CN).send(hdTask());
    expect(res.status).toBe(403);
    expect(regionLines().at(-1)).toMatch(/zone=intl country=CN source=cf forced/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-10-26 最终审核：拒绝话原来只看「这个地区给不给得出 MiniMax」—— 海外的免费用户被指去换 MiniMax，换过去是 403 PLAN_REQUIRED；
// 白模化 / 重拍 / 延长 / 样片第二步被指去换一个根本做不了这件事的 MiniMax。这一组经真的路由钉住「指不指」与套餐门禁说的是同一件事。
describe("门禁 on、海外、这台服务器的 MiniMax 走国际站：拒绝话按这一发与这个人挑", () => {
  const mmBody = () => ({ model: MM_MODEL, prompt: "x", duration: 6, first_frame_image: "https://x.example/1.jpg" });
  beforeEach(() => {
    process.env.VIDEO_REGION_GATE = "on";
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
  });

  test("付费用户的普通出片 → 「换 MiniMax」，而他换过去真走得通", async () => {
    const u = await registerUser("msg_paid");
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "REGION_UNAVAILABLE", providers: ["minimax"], billed: false });
    expect(res.body.message).toMatch(/Switch the model to MiniMax/);
    await request(app).post("/api/minimax/video").set(u.auth).set(US).send(mmBody()).expect(200);
  });

  // 2026-10-26：H3-Lite · 480P（「草稿」在 MiniMax 上的对标）进了免费档。国际站上 V2 开着（config/minimax.minimaxV2Enabled），
  // 所以海外的免费用户被拦 Seedance 时听到的是「换 MiniMax」—— 原来说「MiniMax 要付费套餐」，把人往付钱那边推，而他们有一档免费的。
  // 「V2 没开时才说要付费」的那一句在 tests/videoZone.spec.js（真实配置下造不出，那边换掉了 minimaxV2Enabled）。
  test("★ 免费用户（免费档门禁缺省开）→ 也是「换 MiniMax」：H3-Lite · 480P 对他开着（真人档仍只给付费用户）", async () => {
    const free = await registerUser("msg_free", { plan: null });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(free.auth).set(US).send(hdTask());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "REGION_UNAVAILABLE", providers: ["minimax"], billed: false });
    expect(res.body.message).toMatch(/Switch the model to MiniMax/);
    expect(res.body.message).not.toMatch(/paid plan|付费套餐/);
    // 换过去真走得通：H3-Lite · 480P 那一发按秒扣了钱、发了出去（同一个人、同一个地区；V2 路由走的就是这一份 chargedArkCall）
    const before = await balance(free.id);
    const v2 = await gateway.chargedArkCall({
      user: await free.doc(),
      modelAllowed: () => true,
      kind: "minimax_v2",
      path: "(minimax)/v2/video_generation",
      body: { model: "MiniMax-H3-Lite", resolution: "480P", duration: 5, ratio: "9:16", content: [{ type: "text", text: "海边" }] },
      forward: async () => ({ status: 200, text: JSON.stringify({ task_id: "424010985738629" }) }),
      req: { headers: US },
    });
    expect(v2).toMatchObject({ ok: true, accepted: true, cost: 5 * 11_200 });
    expect(before - (await balance(free.id))).toBe(5 * 11_200);
    // 真人档（v1）对他照旧关着（地区放行，套餐门禁拒）
    const mm = await request(app).post("/api/minimax/video").set(free.auth).set(US).send(mmBody());
    expect(mm.status).toBe(403);
    expect(mm.body.code).toBe("PLAN_REQUIRED");
    expect(calls.some((c) => /video_generation$/.test(c.url))).toBe(false);
  });

  test("免费档门禁关着（FREE_VIDEO_GATE=off，真人档对免费用户也开）→ 免费用户也是「换 MiniMax」", async () => {
    process.env.FREE_VIDEO_GATE = "off";
    const free = await registerUser("msg_free_off", { plan: null });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(free.auth).set(US).send(hdTask());
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Switch the model to MiniMax/);
    const mm = await request(app).post("/api/minimax/video").set(free.auth).set(US).send(mmBody());
    expect(mm.body.code).not.toBe("PLAN_REQUIRED");
  });

  test("挂在免费档上的管理员 → 「换 MiniMax」（套餐门禁对管理员不生效，真人档对他开着；地区门禁照样不豁免）", async () => {
    const admin = await registerUser("msg_admin", { plan: null });
    await User.updateOne({ _id: admin.id }, { $set: { role: "admin" } });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(admin.auth).set(US).send(hdTask());
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Switch the model to MiniMax/);
  });

  test.each([
    ["片段重拍（r2v ownEdit）", { r2v: { kind: "ownEdit", durationSec: 5, sourcePublicId: "p" } }],
    ["往后延长（r2v ownExtend）", { r2v: { kind: "ownExtend", durationSec: 5, outputSec: 5, sourcePublicId: "p" } }],
    ["白模模板段（r2v 命中模板）", { r2v: { templateId: "tpl1", durationSec: 8, sourcePublicId: "p" } }],
    ["样片第二步（draftFinal）", { draftFinal: { draftTaskId: "cgt-x", durationSec: 5 } }],
  ])("chargedArkCall 带 %s → 「没有可换的」：付费用户也不指人去换 MiniMax；照样不扣钱、不出网", async (_label, extra) => {
    const u = await registerUser("msg_noalt");
    const before = await balance(u.id);
    const out = await gateway.chargedArkCall({
      user: await u.doc(),
      modelAllowed: () => true,
      kind: "task",
      path: "/contents/generations/tasks",
      body: hdTask(),
      req: { headers: US },
      ...extra,
    });
    expect(out).toMatchObject({ ok: false, reason: "region", status: 403 });
    expect(out.body.providers).toEqual(["minimax"]);
    expect(out.body.message).not.toMatch(/MiniMax/);
    expect(out.body.message).toMatch(/no other model here/);
    expect(await balance(u.id)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("门禁 observe（缺省）：只记一行 would-deny、照常放行", () => {
  test("没配 VIDEO_REGION_GATE：海外的 Seedance 照常受理、照常扣钱，日志里恰好一行 would-deny", async () => {
    const u = await registerUser("obs_us");
    const before = await balance(u.id);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask());
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^cgt-region-/);
    expect(await balance(u.id)).toBeLessThan(before);
    expect(await ArkVideoTask.countDocuments({ userId: u.id })).toBe(1);
    const lines = regionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[region\] would-deny at=\/contents\/generations\/tasks task doubao-seedance-2-0-mini-260615 zone=intl country=US source=cf /);
    expect(lines[0]).toContain(`user=${u.id}`);
  });

  test("境内不记（本来就不该拦，就没有 would-deny）", async () => {
    const u = await registerUser("obs_cn");
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(CN).send(hdTask()).expect(200);
    expect(regionLines()).toEqual([]);
  });

  test("写了认不出的值也按 observe 跑（放行 + 记）—— 生产上这种配置自检会拒绝启动", async () => {
    process.env.VIDEO_REGION_GATE = "enforce";
    const u = await registerUser("obs_bad");
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask()).expect(200);
    expect(regionLines()).toHaveLength(1);
    expect(regionLines()[0]).toMatch(/would-deny/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("门禁 off：完全不管", () => {
  test("海外照常受理；不判（不去算地区）、不记", async () => {
    process.env.VIDEO_REGION_GATE = "off";
    const zoneSpy = jest.spyOn(videoRegion, "requestZone");
    const u = await registerUser("off_us");
    await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(US).send(hdTask()).expect(200);
    expect(zoneSpy).not.toHaveBeenCalled();
    expect(regionLines()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("只读的轮询 / 取件 / 查询一律不拦（在途任务要能取回）", () => {
  beforeEach(() => {
    process.env.VIDEO_REGION_GATE = "on";
  });

  test("门禁 on、境外：方舟任务轮询照常转发、待取回列表照常回、扣费记录照常查", async () => {
    const u = await registerUser("poll_us");
    // 先在境内受理一发（受理时在境内、取的时候开着 VPN 在海外 —— 正是这条要保的那种人）
    const made = await request(app).post("/api/ark/contents/generations/tasks").set(u.auth).set(CN).send(hdTask()).expect(200);
    const taskId = made.body.id;

    const poll = await request(app).get(`/api/ark/contents/generations/tasks/${taskId}`).set(u.auth).set(US);
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ id: taskId, status: "running" });
    expect(calls.some((c) => c.url === `${ARK}/contents/generations/tasks/${taskId}` && c.method === "GET")).toBe(true);

    const list = await request(app).get("/api/ark/video-tasks").set(u.auth).set(US);
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((t) => t.taskId)).toContain(taskId);

    const charge = await request(app).get(`/api/ark/task-charges/${taskId}`).set(u.auth).set(US);
    expect(charge.status).toBe(200);
    expect(charge.body).toMatchObject({ ok: true, taskId, provider: "ark" });

    expect(regionLines()).toEqual([]);
  });

  test("门禁 on、境外、MiniMax 走中国站：真人档的轮询照常转发（建单会被拦，取件不拦）", async () => {
    process.env.MINIMAX_API_KEY = "mm-cn-test";
    const u = await registerUser("poll_mm");
    const poll = await request(app).get("/api/minimax/video/mm-region-1").set(u.auth).set(US);
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("Processing");
    expect(calls.some((c) => /api\.minimaxi\.com\/v1\/query\/video_generation\?task_id=mm-region-1$/.test(c.url))).toBe(true);
    expect(regionLines()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("真人档（POST /api/minimax/video）也过同一道门：海外只准 MiniMax 国际站", () => {
  const mmBody = () => ({ model: MM_MODEL, prompt: "x", duration: 6, first_frame_image: "https://x.example/1.jpg" });

  beforeEach(() => {
    process.env.VIDEO_REGION_GATE = "on";
  });

  test("这台服务器走中国站、境外请求 → 403 REGION_UNAVAILABLE、不扣钱、不出网；providers 空（海外一家都给不出）", async () => {
    process.env.MINIMAX_API_KEY = "mm-cn-test";
    const u = await registerUser("mm_cn_site");
    const before = await balance(u.id);
    const res = await request(app).post("/api/minimax/video").set(u.auth).set(US).send(mmBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "REGION_UNAVAILABLE", zone: "intl", providers: [], billed: false });
    expect(await balance(u.id)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(regionLines()[0]).toMatch(/^\[region\] deny at=\(minimax\)\/video_generation minimax_video /);
  });

  test("这台服务器走国际站：境外照常受理", async () => {
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    const u = await registerUser("mm_intl_site");
    const res = await request(app).post("/api/minimax/video").set(u.auth).set(US).send(mmBody());
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe("mm-region-1");
    expect(calls.map((c) => c.url)).toEqual(["https://api.minimax.io/v1/video_generation"]);
    expect(regionLines()).toEqual([]);
  });

  test("受全面制裁的地区（IR）：国际站也不给", async () => {
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    const u = await registerUser("mm_ir");
    const res = await request(app).post("/api/minimax/video").set(u.auth).set({ "cf-ipcountry": "IR" }).send(mmBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "REGION_UNAVAILABLE", zone: "blocked", providers: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2026-10-26 审核：kind minimax_v2（MiniMax H3 的 V2 出片）一度只进了 tokens.isVideoGeneration、没进 videoRegion.gatedProviderOf ——
// regionGate 见 null 就整个跳过：门禁 on 也不拦受全面制裁的地区、observe 不记 would-deny、没带 req 也不抛。全程零症状。
// 这里直接调 chargedArkCall / regionGate 钉住判据（写这一组时 V2 路由还没有）；路由（POST /api/minimax/v2/video）接上之后
// 经路由走一遍的那一条在 tests/minimaxV2.spec.js「出片地区门禁（on）」。
describe("MiniMax H3（kind minimax_v2）过同一道门：海外只准国际站、受全面制裁的地区一家都不给", () => {
  const IR = { "cf-ipcountry": "IR" };
  const v2Body = () => ({ model: "MiniMax-H3-Lite", resolution: "480P", duration: 5, ratio: "9:16", content: [{ type: "text", text: "海边" }] });
  const v2Call = async (u, headers, forward = jest.fn(async () => ({ status: 200, text: JSON.stringify({ task_id: "424010985738629" }) }))) => ({
    forward,
    out: await gateway.chargedArkCall({
      user: await u.doc(),
      modelAllowed: () => true,
      kind: "minimax_v2",
      path: "(minimax)/v2/video_generation",
      body: v2Body(),
      forward,
      req: headers === undefined ? undefined : { headers },
    }),
  });

  beforeEach(() => {
    process.env.VIDEO_REGION_GATE = "on";
  });

  test("国际站：受全面制裁的地区（IR）→ 403 REGION_UNAVAILABLE、不扣钱、不转发；话里不指人去换 MiniMax", async () => {
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    const u = await registerUser("v2_ir");
    const before = await balance(u.id);
    const { out, forward } = await v2Call(u, IR);
    expect(out).toMatchObject({ ok: false, reason: "region", status: 403, wallet: null });
    expect(out.body).toMatchObject({ ok: false, code: "REGION_UNAVAILABLE", zone: "blocked", providers: [], billed: false });
    expect(out.body.message).not.toMatch(/MiniMax/);
    expect(forward).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
    expect(regionLines()[0]).toMatch(/^\[region\] deny at=\(minimax\)\/v2\/video_generation minimax_v2 MiniMax-H3-Lite zone=blocked /);
  });

  test("国际站：境外（美国）/ 境内照常受理、按秒扣钱", async () => {
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    for (const headers of [US, CN]) {
      const u = await registerUser("v2_ok");
      const before = await balance(u.id);
      const { out, forward } = await v2Call(u, headers);
      expect(out).toMatchObject({ ok: true, accepted: true, cost: 5 * 11_200 });
      expect(forward).toHaveBeenCalledTimes(1);
      expect(before - (await balance(u.id))).toBe(5 * 11_200);
    }
    expect(regionLines()).toEqual([]);
  });

  test("中国站：境外也拦（海外只准国际站），providers 空", async () => {
    process.env.MINIMAX_API_KEY = "mm-cn-test";
    const u = await registerUser("v2_cn_site");
    const { out, forward } = await v2Call(u, US);
    expect(out).toMatchObject({ ok: false, reason: "region", status: 403 });
    expect(out.body).toMatchObject({ code: "REGION_UNAVAILABLE", zone: "intl", providers: [] });
    expect(forward).not.toHaveBeenCalled();
  });

  test.each(["observe", "on"])("gate=%s：没带 req → 抛（扣钱之前：余额不动、不转发）—— 零症状的漏传要响", async (gate) => {
    process.env.VIDEO_REGION_GATE = gate;
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    const u = await registerUser(`v2_noreq_${gate}`);
    const before = await balance(u.id);
    const forward = jest.fn();
    await expect(v2Call(u, undefined, forward)).rejects.toThrow(/必须把 req 交进来/);
    expect(forward).not.toHaveBeenCalled();
    expect(await balance(u.id)).toBe(before);
  });

  test("observe：受全面制裁的地区记一行 would-deny、照常放行（V2 不再悄悄漏在门禁外面）", async () => {
    process.env.VIDEO_REGION_GATE = "observe";
    process.env.MINIMAX_INTL_API_KEY = "mm-intl-test";
    const u = await registerUser("v2_observe");
    const { out } = await v2Call(u, IR);
    expect(out).toMatchObject({ ok: true, accepted: true });
    expect(regionLines()).toHaveLength(1);
    expect(regionLines()[0]).toMatch(/^\[region\] would-deny .* minimax_v2 MiniMax-H3-Lite zone=blocked/);
  });

  test("没配 MiniMax：不归这道闸管（V2 路由在扣费之前就 501，到不了钱上）—— regionGate 不看 req", () => {
    expect(gateway.regionGate({ req: undefined, user: null, kind: "minimax_v2", model: "MiniMax-H3-Lite", at: "t" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("chargedArkCall / regionGate 直接调", () => {
  const seedanceArgs = (doc, extra = {}) => ({
    user: doc,
    modelAllowed: () => true,
    kind: "task",
    path: "/contents/generations/tasks",
    body: hdTask(),
    ...extra,
  });

  test.each(["observe", "on"])("gate=%s：归门禁管的一发没带 req → 抛（扣钱之前：余额不动、不出网）", async (gate) => {
    process.env.VIDEO_REGION_GATE = gate;
    const u = await registerUser(`noreq_${gate}`);
    const before = await balance(u.id);
    await expect(gateway.chargedArkCall(seedanceArgs(await u.doc()))).rejects.toThrow(TypeError);
    await expect(gateway.chargedArkCall(seedanceArgs(await u.doc()))).rejects.toThrow(/必须把 req 交进来/);
    expect(await balance(u.id)).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("gate=off：连 req 都不看（急停开关要能把这道闸整个摘掉）", async () => {
    process.env.VIDEO_REGION_GATE = "off";
    const u = await registerUser("noreq_off");
    const out = await gateway.chargedArkCall(seedanceArgs(await u.doc()));
    expect(out).toMatchObject({ ok: true, accepted: true });
  });

  test("不归门禁管的调用（出图 / 对话）不带 req 照常走（服务端自己发起的调用手上可能没有 req）", async () => {
    process.env.VIDEO_REGION_GATE = "on";
    const u = await registerUser("noreq_img");
    const doc = await u.doc();
    const img = await gateway.chargedArkCall({ user: doc, modelAllowed: () => true, kind: "image", path: "/images/generations", body: { model: IMAGE, prompt: "x" } });
    expect(img).toMatchObject({ ok: true, accepted: true });
    const chat = await gateway.chargedArkCall({ user: doc, modelAllowed: () => true, kind: "chat", path: "/chat/completions", body: { model: CHAT, messages: [] } });
    expect(chat).toMatchObject({ ok: true, accepted: true });
  });

  test("on 被拦：回 reason 'region'、403、wallet:null；body 与路由回出去的是同一份（billed:false）", async () => {
    process.env.VIDEO_REGION_GATE = "on";
    const u = await registerUser("direct_on");
    const out = await gateway.chargedArkCall(seedanceArgs(await u.doc(), { req: { headers: US } }));
    expect(out).toMatchObject({ ok: false, reason: "region", status: 403, wallet: null });
    expect(out.body).toMatchObject({ ok: false, code: "REGION_UNAVAILABLE", reason: "region", zone: "intl", billed: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("同一个请求过两次门（白模化：预检 + Seedance 那一发）：observe 只记一行；on 每次都拦、每次都记；结论只算一次地区", async () => {
    const zoneSpy = jest.spyOn(videoRegion, "requestZone");
    const args = { user: null, kind: "task", model: MINI, at: "t" };

    process.env.VIDEO_REGION_GATE = "observe";
    const req1 = { headers: US };
    expect(gateway.regionGate({ ...args, req: req1 })).toBeNull();
    expect(gateway.regionGate({ ...args, req: req1 })).toBeNull();
    expect(regionLines()).toHaveLength(1);
    expect(zoneSpy).toHaveBeenCalledTimes(1);
    // 另一个请求另记一行
    expect(gateway.regionGate({ ...args, req: { headers: US } })).toBeNull();
    expect(regionLines()).toHaveLength(2);

    process.env.VIDEO_REGION_GATE = "on";
    const req2 = { headers: US };
    const a = gateway.regionGate({ ...args, req: req2 });
    const b = gateway.regionGate({ ...args, req: req2 });
    expect(a).toEqual(b);
    expect(a.status).toBe(403);
    expect(regionLines().filter((s) => s.startsWith("[region] deny"))).toHaveLength(2);
  });

  test("日志行过 logSafe：at / model 里塞换行伪造不出第二行", () => {
    process.env.VIDEO_REGION_GATE = "observe";
    // model 走 gatedProviderOf 之前必须是 Seedance，所以拿 at 来塞
    gateway.regionGate({ req: { headers: US }, user: null, kind: "task", model: MINI, at: "x\n[region] deny at=fake" });
    const lines = regionLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("调用方都把 req 交进来（扫源码）", () => {
  /**
   * 把注释换成空白（换行留着，行号不变），字符串 / 模板串 / 正则字面量原样留着。
   * ★ 为什么要先剥注释（2026-10-26 最终审核）：原来注释里那句示范写法 `arkGateway.regionGate({ req, user, kind, model, at })`
   *   也被算成一处调用 —— 「至少 2 处」有一半是一行注释凑的，真的调用点少了一处这条照样绿。
   * ★ 不能按行粗暴地砍 `//`：源码里满是 `https://…` 字符串与 `/\/v1\/…/` 正则。所以是个小词法器：认得 '…' "…" `…${…}…`（可嵌套）
   *   与正则字面量（`/` 前面是运算符 / 括号 / 关键字时才算正则，其余当除号）。剥完拿 vm.compileFunction 再编一遍（下面那条用例）——
   *   剥坏了多半就编不过，这个小词法器自己也有人看着。
   */
  function stripComments(src) {
    let out = "";
    let i = 0;
    const n = src.length;
    const tplDepth = []; // 每进一层模板串的 ${，记下进去时的花括号深度
    let depth = 0;
    let prev = ""; // 上一个有意义的代码字符
    let word = ""; // 上一个标识符（判 `return /x/` 这类）
    const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
    const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);
    /** 人在模板串里（i 指着反引号之后、或 `${…}` 的 `}` 之后）：原样抄到结尾的反引号，或抄到下一个 `${` 就回到代码里 */
    const continueTemplate = () => {
      let j = i;
      let inExpr = false;
      while (j < n) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "`") {
          j += 1;
          break;
        } else if (src[j] === "$" && src[j + 1] === "{") {
          j += 2;
          inExpr = true;
          break;
        } else j += 1;
      }
      out += src.slice(i, j);
      i = j;
      if (inExpr) {
        tplDepth.push(depth);
        depth += 1;
        prev = "{";
      } else prev = "`";
    };
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && src[i] !== "\n") {
          out += " ";
          i += 1;
        }
        continue;
      }
      if (c === "/" && d === "*") {
        const close = src.indexOf("*/", i + 2);
        const stop = close < 0 ? n : close + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, " ");
        i = stop;
        continue;
      }
      if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j + 1;
        prev = c;
        continue;
      }
      if (c === "`") {
        out += "`";
        i += 1;
        continueTemplate();
        continue;
      }
      if (c === "/" && (prev === "" || REGEX_AFTER.test(prev) || (/[A-Za-z_$]/.test(prev) && REGEX_KEYWORDS.has(word)))) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 2;
          else if (src[j] === "[") (inClass = true), (j += 1);
          else if (src[j] === "]") (inClass = false), (j += 1);
          else if (src[j] === "/" && !inClass) break;
          else j += 1;
        }
        j += 1;
        while (j < n && /[a-z]/i.test(src[j])) j += 1;
        out += src.slice(i, j);
        i = j;
        prev = "/";
        word = "";
        continue;
      }
      if (c === "{") depth += 1;
      if (c === "}") {
        depth -= 1;
        if (tplDepth.length && depth === tplDepth[tplDepth.length - 1]) {
          tplDepth.pop();
          out += "}";
          i += 1;
          continueTemplate();
          continue;
        }
      }
      if (/[A-Za-z_$0-9]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z_$0-9]/.test(src[j])) j += 1;
        word = src.slice(i, j);
        out += word;
        prev = src[j - 1];
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        prev = c;
        word = "";
      }
      out += c;
      i += 1;
    }
    return out;
  }

  /** 从 `name({` 的 `{` 起，取出配平的那一整段对象字面量（这几处调用里的字符串 / 模板串都是配平的） */
  function callObjects(src, name) {
    const out = [];
    // `name({` 与 `name( {` 都认（下面那条「只许对象字面量」放行的正是这两种写法，这里得都扫得进去）
    const re = new RegExp(`(?<!function\\s)\\b${name}\\s*\\(\\s*\\{`, "g");
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length - 1;
      let depth = 0;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      out.push(src.slice(start, i + 1));
    }
    return out;
  }
  function srcFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? srcFiles(p) : p.endsWith(".js") ? [p] : [];
    });
  }
  // 扫的是**剥掉注释之后**的源码（理由见 stripComments）
  const files = srcFiles(path.join(__dirname, "..", "src")).map((p) => {
    const raw = fs.readFileSync(p, "utf8");
    return { p, rel: path.relative(path.join(__dirname, ".."), p), raw, src: stripComments(raw) };
  });
  // 对象里有一个顶层写法的 `req` 键（`req,` / `req }` / `req: req`）。`req.user` 不算
  const hasReq = (obj) => /(^|[{,\s])req\s*([,}]|:\s*req\b)/.test(obj);

  test("剥注释的小词法器没把代码剥坏：每个 src 文件剥完照样编得过，行数不变，字符串里的 // 一个没少", () => {
    const vm = require("vm");
    expect(files.length).toBeGreaterThan(50);
    for (const { rel, raw, src } of files) {
      expect([rel, src.split("\n").length]).toEqual([rel, raw.split("\n").length]);
      // CommonJS 的外壳与 Node 自己包的一样；编不过 = 把字符串 / 正则当注释剥了
      expect(() => vm.compileFunction(src, ["exports", "require", "module", "__filename", "__dirname"], { filename: rel })).not.toThrow();
    }
    // 对照：带 URL 的字符串原样留着（按行砍 // 的写法会把它们剥掉）
    const gw = files.find((f) => f.rel.replace(/\\/g, "/") === "src/services/arkGateway.service.js");
    expect(gw.src).toContain('"https://ark.cn-beijing.volces.com/api/v3"');
    // 注释确实没了：videoRegion 文件头里那句示范写法不再被当成调用
    const vr = files.find((f) => f.rel.replace(/\\/g, "/") === "src/config/videoRegion.js");
    expect(vr.raw).toMatch(/arkGateway\.regionGate/);
    expect(vr.src).not.toMatch(/regionGate\s*\(/);
  });

  test.each(["chargedArkCall", "regionGate"])("每一处 %s({…}) 都带 req —— 漏了的话 Seedance / 真人档那一发在 observe / on 下当场抛", (name) => {
    const found = files.flatMap(({ rel, src }) => callObjects(src, name).map((obj) => ({ p: rel, obj })));
    // 别让这条在一个调用点都没扫到的时候空转（今天 chargedArkCall 5 处；regionGate 3 处 —— chargedArkCall 里那一处 + 白模化的预检 + H3 出片在并发闸之前的预检）。
    // ★ 剥了注释之后数的才是真调用（原来注释里那句示范写法也算一处）
    expect(found.length).toBeGreaterThanOrEqual(name === "chargedArkCall" ? 5 : 3);
    const missing = found.filter((f) => !hasReq(f.obj)).map((f) => `${f.p}: ${f.obj.slice(0, 80)}`);
    expect(missing).toEqual([]);
  });

  test.each(["chargedArkCall", "regionGate"])("%s 只许拿对象字面量调（传变量 / 展开 / 经 .call .apply 转一手的扫不到里面带没带 req，一律不许）", (name) => {
    // ★ `name(` 后面不是 `{`（变量、展开、函数调用的结果）、或者经 .call / .apply / .bind 转一手：上面那条扫不进去，漏传 req 就逃过去了
    const re = new RegExp(`(?<!function\\s)\\b${name}\\s*(?:\\((?!\\s*\\{)|\\.\\s*(?:call|apply|bind)\\b)`, "g");
    const bad = files.flatMap(({ rel, src }) => [...src.matchAll(re)].map((m) => `${rel}: ${src.slice(m.index, m.index + 60)}`));
    expect(bad).toEqual([]);
    // 这条正则自己是活的：拿几种该抓的写法对一遍（别让它因为写错而永远是空的）
    for (const s of [`${name}(opts)`, `${name}( args )`, `x.${name}(...a)`, `${name}.call(null, o)`, `${name}.apply(null, [o])`]) {
      expect([s, [...s.matchAll(re)].length]).toEqual([s, 1]);
    }
    for (const s of [`${name}({ req })`, `${name}( { req } )`, `async function ${name}({ a })`]) {
      expect([s, [...s.matchAll(re)].length]).toEqual([s, 0]);
    }
  });
});
