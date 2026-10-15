// tests/arkImageAlias.spec.js
// 出图模型的接班（方舟第十批下线，2026-11-24 14:00 停服；主人 2026-10-10 拍板）：
// 已经装机的老 App 还在发的出图 id，**只在发给方舟的那一刻**换成接班型号。
//
// ★ 这几条守的都是「拆掉也不报错」的那种：
//   ① 换早了 / 换晚了：4.5 在 11-24 13:00 之前就换成 5.0 pro = 提前一个多月改了老用户的画风；过了点还没换 = 那批出图整条 400。
//   ② 换在计价之前：老包按接班型号的价被扣钱 —— 4.5 的老包报 16,667、扣 40,000，"页面报 X、实际扣 Y"。
//   ③ 组图那条路照抄单张的接班（4.5 → 5.0 pro）：5.0 pro 出不了组图，发 4.5 的那一组（契约收它）整组被拒、钱退回、图没有。
//   ④ 流水 memo 只写一半：月底对方舟账单时，账单上的型号在我们的流水里找不到。
//   ⑤ 应急开关失灵：回滚的时候关不掉。
//   ⑥ 碰到了视频：1.0 是**停用**（400 MODEL_RETIRED），不是接班 —— 悄悄换模型等于换了用户买的东西。
// ★ 不真的打方舟：fetch 换成间谍，断言「发出去的是哪个型号」靠它，不靠推理。
// ★ 时间：判据收 `now`（config/tokens.upstreamImageModel / arkGateway.chargedArkCall / arkImageGroup.startImageGroup），
//   切换前后各跑一遍；走 HTTP 的用例只用「部署即切」的那一条（老 4.0），不会在 11-24 那天无缘无故变红。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let tokens;
let wallet;
let gateway;
let imageGroups;
let User;
let TokenLedger;
let ArkImageGroup;
let fetchSpy;

const OLD_40 = "doubao-seedream-4-0-250828";
const NEW_40 = "doubao-seedream-4-0-20260415";
const OLD_45 = "doubao-seedream-4-5-251128";
const PRO_50 = "doubao-seedream-5-0-pro-260628";
const LITE_50 = "doubao-seedream-5-0-260128";
const MINI = "doubao-seedance-2-0-mini-260615";

/** 切换时刻（北京时间 13:00）的前一毫秒 / 那一刻 / 之后 */
const SWITCH = Date.parse("2026-11-24T13:00:00+08:00");
const BEFORE = SWITCH - 1;
const AT = SWITCH;
const AFTER = Date.parse("2026-12-01T00:00:00+08:00");

async function registerUser(tag) {
  const name = `ia_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  const id = res.body.user._id;
  return { id, auth: { Authorization: `Bearer ${res.body.token}` }, doc: await User.findById(id).lean() };
}

const balance = async (id) => {
  const w = await wallet.getWallet(id);
  return w.plan + w.addon;
};
const memos = async (id) => (await TokenLedger.find({ user: id }).sort({ createdAt: 1, _id: 1 }).lean()).map((r) => r.memo);

/** 出图回包（单张）：200 + 一张图 */
const imageOk = () => ({ status: 200, text: async () => JSON.stringify({ data: [{ url: "https://x.volces.com/1.jpeg" }] }) });
/** 最近一次出网发出去的请求体 */
const lastSent = () => {
  const call = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
  return { url: String(call[0]), body: JSON.parse(call[1].body) };
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.ARK_API_KEY = "test-key-not-real";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  tokens = require("../src/config/tokens");
  wallet = require("../src/services/tokenWallet.service");
  gateway = require("../src/services/arkGateway.service");
  imageGroups = require("../src/services/arkImageGroup.service");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  ArkImageGroup = require("../src/models/ArkImageGroup");
  await ArkImageGroup.init();
});

afterAll(async () => {
  delete process.env.ARK_API_KEY;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  delete process.env.ARK_IMAGE_ALIAS;
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("这条用例不该出网");
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.ARK_IMAGE_ALIAS;
});

describe("判据（config/tokens.upstreamImageModel）：哪个 id 在哪一刻换成谁", () => {
  test("老 4.0 → 4.0 新版本：部署即切，与时刻无关（单张、组图一样）", () => {
    for (const now of [Date.parse("2026-01-01T00:00:00Z"), BEFORE, AT, AFTER, Date.now()]) {
      expect(tokens.upstreamImageModel(OLD_40, { now })).toBe(NEW_40);
      expect(tokens.upstreamImageModel(OLD_40, { group: true, now })).toBe(NEW_40);
    }
  });

  test("4.5：13:00 之前原样；13:00 那一刻起单张 → 5.0 pro、组图 → 4.0 新版本（5.0 pro 出不了组图）", () => {
    expect(tokens.upstreamImageModel(OLD_45, { now: BEFORE })).toBe(OLD_45);
    expect(tokens.upstreamImageModel(OLD_45, { group: true, now: BEFORE })).toBe(OLD_45);
    for (const now of [AT, AFTER]) {
      expect(tokens.upstreamImageModel(OLD_45, { now })).toBe(PRO_50);
      expect(tokens.upstreamImageModel(OLD_45, { group: true, now })).toBe(NEW_40);
    }
  });

  test("5.0 lite（很老的包）：13:00 之前原样，之后 → 4.0 新版本", () => {
    expect(tokens.upstreamImageModel(LITE_50, { now: BEFORE })).toBe(LITE_50);
    expect(tokens.upstreamImageModel(LITE_50, { now: AT })).toBe(NEW_40);
    expect(tokens.upstreamImageModel(LITE_50, { now: AFTER })).toBe(NEW_40);
  });

  test("切换时刻按北京时间写死：13:00 +08:00 = 05:00 UTC（时区写错的症状是早切或晚切八小时）", () => {
    expect(tokens.upstreamImageModel(OLD_45, { now: Date.parse("2026-11-24T04:59:59.999Z") })).toBe(OLD_45);
    expect(tokens.upstreamImageModel(OLD_45, { now: Date.parse("2026-11-24T05:00:00.000Z") })).toBe(PRO_50);
    // 也收 Date 对象
    expect(tokens.upstreamImageModel(OLD_45, { now: new Date(AFTER) })).toBe(PRO_50);
  });

  test("与视频停用同一个时刻（方舟 14:00 停服，我们都提前到 13:00）", () => {
    const at = new Set(Object.values(tokens.RETIRED_MODELS_AT).map((s) => Date.parse(s)));
    for (const rule of Object.values(tokens.IMAGE_MODEL_SUCCESSORS)) {
      if (rule.from !== null) expect(at.has(Date.parse(rule.from))).toBe(true);
    }
  });

  test("不在表里的一律原样：新 id、5.0 pro、视频、对话、原型链上的名字、空", () => {
    for (const m of [NEW_40, PRO_50, MINI, "doubao-seedance-1-0-pro-250528", "doubao-seed-2-1-turbo-260628", "constructor", "toString", "__proto__", ""]) {
      expect(tokens.upstreamImageModel(m, { now: AFTER })).toBe(m);
      expect(tokens.upstreamImageModel(m, { group: true, now: AFTER })).toBe(m);
    }
    expect(tokens.upstreamImageModel(undefined, { now: AFTER })).toBe("");
  });

  test("应急开关 ARK_IMAGE_ALIAS=off（大小写 / 空格不论）：整张表不生效；别的值照常换", () => {
    for (const v of ["off", "OFF", " Off "]) {
      process.env.ARK_IMAGE_ALIAS = v;
      expect(tokens.imageAliasOn()).toBe(false);
      for (const m of [OLD_40, OLD_45, LITE_50]) {
        expect(tokens.upstreamImageModel(m, { now: AFTER })).toBe(m);
        expect(tokens.upstreamImageModel(m, { group: true, now: AFTER })).toBe(m);
      }
    }
    for (const v of ["on", "", "0", "false"]) {
      process.env.ARK_IMAGE_ALIAS = v;
      expect(tokens.upstreamImageModel(OLD_40, { now: AFTER })).toBe(NEW_40);
    }
  });

  test("表本身的不变量：接班型号在册有价、组图的接班型号能出组图、表里没有视频", () => {
    for (const [from, rule] of Object.entries(tokens.IMAGE_MODEL_SUCCESSORS)) {
      expect(tokens.IMAGE_MODELS.has(from)).toBe(true); // 老 id 还在册（装机的包还在发）
      expect(tokens.IMAGE_MODELS.has(rule.to)).toBe(true);
      expect(Object.hasOwn(tokens.VIDEO_MULT, from)).toBe(false);
      // 老 id 能出组图的，接班之后也必须能（否则九宫格整组 400）
      if (tokens.GROUP_IMAGE_MODELS.has(from)) expect(tokens.GROUP_IMAGE_MODELS.has(rule.groupTo ?? rule.to)).toBe(true);
      // 时刻要么「部署即切」，要么是一个带时区的合法时刻
      if (rule.from !== null) {
        expect(rule.from).toMatch(/\+08:00$/);
        expect(Number.isFinite(Date.parse(rule.from))).toBe(true);
      }
    }
  });

  test("价钱**不跟着换**：按发来的 id 收（4.5 的老包报 16,667，不按 5.0 pro 的 40,000、也不按 4.0 的 13,333）", () => {
    expect(tokens.priceOf("image", { model: OLD_45 })).toBe(16_667);
    expect(tokens.priceOf("image", { model: OLD_40 })).toBe(13_333);
    expect(tokens.priceOf("image", { model: LITE_50 })).toBe(13_300);
    expect(tokens.priceOf("image", { model: PRO_50 })).toBe(40_000);
  });
});

describe("单张出图的出口（arkGateway.chargedArkCall）", () => {
  const allowAll = () => true;
  const call = (user, body, extra = {}) =>
    gateway.chargedArkCall({ user, modelAllowed: allowAll, kind: "image", path: "/images/generations", body, ...extra });

  test("走 HTTP：老 4.0 发出去的是 4.0 新版本；按老 4.0 的价扣；流水写「发来的→真发的」；回包原样透传", async () => {
    const u = await registerUser("http40");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () => imageOk());
    const res = await request(app).post("/api/ark/images/generations").set(u.auth).send({ model: OLD_40, prompt: "x", size: "2K" }).expect(200);
    expect(res.body).toEqual({ data: [{ url: "https://x.volces.com/1.jpeg" }] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, body } = lastSent();
    expect(url).toMatch(/\/images\/generations$/);
    expect(body).toEqual({ model: NEW_40, prompt: "x", size: "2K" });
    expect(await balance(u.id)).toBe(before - 13_333);
    expect(await memos(u.id)).toContain(`image ${OLD_40}→${NEW_40}`);
  });

  test("走 HTTP：App 2.63 发的新 id 原样发出去，流水只写一个型号", async () => {
    const u = await registerUser("httpnew");
    fetchSpy.mockImplementation(async () => imageOk());
    await request(app).post("/api/ark/images/generations").set(u.auth).send({ model: NEW_40, prompt: "x" }).expect(200);
    expect(lastSent().body.model).toBe(NEW_40);
    const m = await memos(u.id);
    expect(m).toContain(`image ${NEW_40}`);
    expect(m.some((s) => s.includes("→"))).toBe(false);
  });

  test("4.5：切换之前原样发；切换之后发 5.0 pro，但仍按 4.5 的 16,667 扣、流水两个型号都在", async () => {
    const u = await registerUser("g45");
    fetchSpy.mockImplementation(async () => imageOk());
    const start = await balance(u.id);

    const pre = await call(u.doc, { model: OLD_45, prompt: "x" }, { now: BEFORE });
    expect(pre).toMatchObject({ ok: true, accepted: true, cost: 16_667, upstreamModel: OLD_45, memo: `image ${OLD_45}` });
    expect(lastSent().body.model).toBe(OLD_45);

    const post = await call(u.doc, { model: OLD_45, prompt: "x" }, { now: AFTER });
    expect(post).toMatchObject({ ok: true, accepted: true, cost: 16_667, upstreamModel: PRO_50, memo: `image ${OLD_45}→${PRO_50}` });
    expect(lastSent().body).toEqual({ model: PRO_50, prompt: "x" });

    expect(await balance(u.id)).toBe(start - 2 * 16_667);
  });

  test("5.0 lite：切换之后发 4.0 新版本，按老包的 13,300 扣", async () => {
    const u = await registerUser("g50l");
    fetchSpy.mockImplementation(async () => imageOk());
    const out = await call(u.doc, { model: LITE_50, prompt: "x" }, { now: AT });
    expect(out).toMatchObject({ ok: true, cost: 13_300, upstreamModel: NEW_40, memo: `image ${LITE_50}→${NEW_40}` });
    expect(lastSent().body.model).toBe(NEW_40);
  });

  test("调用方的 body 不被改（换的是转发的那一份）", async () => {
    const u = await registerUser("nomut");
    fetchSpy.mockImplementation(async () => imageOk());
    const body = { model: OLD_40, prompt: "x" };
    await call(u.doc, body);
    expect(body.model).toBe(OLD_40);
    expect(lastSent().body.model).toBe(NEW_40);
  });

  test("接了班的那一发被方舟拒（400）：原样退回，退款流水也写着两个型号", async () => {
    const u = await registerUser("refund");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () => ({ status: 400, text: async () => JSON.stringify({ error: { code: "InputTextSensitiveContentDetected" } }) }));
    const out = await call(u.doc, { model: OLD_45, prompt: "x" }, { now: AFTER });
    expect(out).toMatchObject({ ok: true, accepted: false, status: 400 });
    expect(await balance(u.id)).toBe(before);
    expect(await memos(u.id)).toEqual(expect.arrayContaining([`image ${OLD_45}→${PRO_50}`, `image ${OLD_45}→${PRO_50} 未受理`]));
  });

  test("应急开关关着：老 id 原样发出去，流水只写一个型号（回滚就是这样）", async () => {
    process.env.ARK_IMAGE_ALIAS = "off";
    const u = await registerUser("kill");
    fetchSpy.mockImplementation(async () => imageOk());
    await request(app).post("/api/ark/images/generations").set(u.auth).send({ model: OLD_40, prompt: "x" }).expect(200);
    expect(lastSent().body.model).toBe(OLD_40);
    const out = await call(u.doc, { model: OLD_45, prompt: "x" }, { now: AFTER });
    expect(out).toMatchObject({ upstreamModel: OLD_45, memo: `image ${OLD_45}` });
    expect(lastSent().body.model).toBe(OLD_45);
  });

  test("不在册的老 id 不会被「换」进来：在册检查排在接班前面（400、不出网）", async () => {
    const u = await registerUser("notallowed");
    const out = await gateway.chargedArkCall({
      user: u.doc,
      modelAllowed: (m) => m !== OLD_40,
      kind: "image",
      path: "/images/generations",
      body: { model: OLD_40, prompt: "x" },
    });
    expect(out).toMatchObject({ ok: false, reason: "model", status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("视频与对话不碰：Seedance 任务的 model 原样、流水是 `task <model>`；kind 不是 image 时哪怕 model 是表里的老出图 id 也不换", async () => {
    const u = await registerUser("video");
    fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "cgt-alias-video-1" }) }));
    // 草稿档（2.0 mini · 480p）免费版也能出 —— 走真路由，过钉子与门禁
    await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(u.auth)
      .send({ model: MINI, content: [{ type: "text", text: "x" }], duration: 5, resolution: "480p", ratio: "9:16" })
      .expect(200);
    expect(lastSent().body.model).toBe(MINI);
    expect(await memos(u.id)).toContain(`task ${MINI}`);
    // 直接调：kind 不是 image 时，哪怕 model 是表里的老出图 id 也一个字不改（判据只在出图的出口上问）
    fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "x" }) }));
    const out = await gateway.chargedArkCall({
      user: u.doc,
      modelAllowed: () => true,
      kind: "chat",
      path: "/chat/completions",
      body: { model: OLD_40, messages: [] },
      now: AFTER,
    });
    expect(out).toMatchObject({ ok: true, upstreamModel: OLD_40, memo: `chat ${OLD_40}` });
    expect(lastSent().body.model).toBe(OLD_40);
  });
});

/** 假的 SSE 流（事件形状照官方「图片生成流式响应事件」） */
function sseResponse(events) {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i >= events.length) return c.close();
      const ev = events[i++];
      c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const okEv = (i, model) => ({ type: "image_generation.partial_succeeded", model, image_index: i, url: `https://x.volces.com/g/${i}.jpeg`, size: "1440x2560" });
const doneEv = (n, model) => ({ type: "image_generation.completed", model, usage: { generated_images: n } });
const groupBody = (model, extra = {}) => ({
  model,
  prompt: "生成 2 张连续的电影分镜画面",
  image: ["https://res.cloudinary.com/x/a.jpg"],
  size: "1440x2560",
  max_images: 2,
  ...extra,
});

async function waitGroup(u, id) {
  for (let k = 0; k < 150; k++) {
    const res = await request(app).get(`/api/ark/image-groups/${id}`).set(u.auth);
    if (res.status === 200 && res.body.group.status !== "running") return res.body.group;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到这一组结束：${id}`);
}
async function memosSettle(id, pred) {
  for (let k = 0; k < 100; k++) {
    const m = await memos(id);
    if (pred(m)) return m;
    await new Promise((r) => setTimeout(r, 20));
  }
  return memos(id);
}

describe("组图的出口（arkImageGroup.startImageGroup）", () => {
  test("4.5 切换之后：组图接到 4.0 新版本（**不是** 5.0 pro）；单价、预扣、库里的 model、回给客户端的 model 都还是 4.5", async () => {
    const u = await registerUser("grp45");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () => sseResponse([okEv(0, NEW_40), okEv(1, NEW_40), doneEv(2, NEW_40)]));
    const out = await imageGroups.startImageGroup({ user: u.doc, body: groupBody(OLD_45), now: AFTER });
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ unitCost: 16_667, prepaid: 2 * 16_667 });

    const g = await waitGroup(u, out.body.id);
    expect(g).toMatchObject({ status: "done", model: OLD_45, generated: 2, charged: 2 * 16_667 });
    expect(g.upstreamModel).toBeUndefined(); // 只为对账，不回给客户端

    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sent.model).toBe(NEW_40);
    expect(sent.sequential_image_generation).toBe("auto");

    const doc = await ArkImageGroup.findById(out.body.id).lean();
    expect(doc).toMatchObject({ model: OLD_45, upstreamModel: NEW_40 });
    expect(await balance(u.id)).toBe(before - 2 * 16_667);
    expect(await memos(u.id)).toContain(`image ${OLD_45}→${NEW_40} 组图×2`);
  });

  test("4.5 切换之前：原样发 4.5", async () => {
    const u = await registerUser("grp45pre");
    fetchSpy.mockImplementation(async () => sseResponse([okEv(0, OLD_45), doneEv(1, OLD_45)]));
    const out = await imageGroups.startImageGroup({ user: u.doc, body: groupBody(OLD_45), now: BEFORE });
    await waitGroup(u, out.body.id);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe(OLD_45);
    expect((await ArkImageGroup.findById(out.body.id).lean()).upstreamModel).toBe(OLD_45);
    expect(await memos(u.id)).toContain(`image ${OLD_45} 组图×2`);
  });

  test("走 HTTP：老 4.0 的组图部署即切；只画出 1 张时多扣的退回，退款那一笔的 memo 与扣款那一笔是同一个写法", async () => {
    const u = await registerUser("grp40");
    const before = await balance(u.id);
    fetchSpy.mockImplementation(async () => sseResponse([okEv(0, NEW_40), doneEv(1, NEW_40)]));
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody(OLD_40)).expect(202);
    const g = await waitGroup(u, res.body.id);
    expect(g).toMatchObject({ model: OLD_40, generated: 1, charged: 13_333 });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe(NEW_40);
    const m = await memosSettle(u.id, (xs) => xs.filter((s) => s.includes("组图")).length >= 2);
    const groupMemos = m.filter((s) => s.includes("组图"));
    expect(groupMemos.length).toBeGreaterThanOrEqual(2); // 预扣 + 冲正
    for (const s of groupMemos) expect(s.startsWith(`image ${OLD_40}→${NEW_40} 组图×2`)).toBe(true);
    expect(await balance(u.id)).toBe(before - 13_333);
  });

  test("应急开关关着：组图里的老 id 原样发出去", async () => {
    process.env.ARK_IMAGE_ALIAS = "off";
    const u = await registerUser("grpkill");
    fetchSpy.mockImplementation(async () => sseResponse([okEv(0, OLD_45), doneEv(1, OLD_45)]));
    const out = await imageGroups.startImageGroup({ user: u.doc, body: groupBody(OLD_45), now: AFTER });
    await waitGroup(u, out.body.id);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe(OLD_45);
  });

  test("App 2.63 的新 id 能出组图（在 GROUP_IMAGE_MODELS 里），原样发出去", async () => {
    const u = await registerUser("grpnew");
    fetchSpy.mockImplementation(async () => sseResponse([okEv(0, NEW_40), doneEv(1, NEW_40)]));
    const res = await request(app).post("/api/ark/image-groups").set(u.auth).send(groupBody(NEW_40)).expect(202);
    expect(res.body.unitCost).toBe(13_333);
    await waitGroup(u, res.body.id);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).model).toBe(NEW_40);
  });
});

describe("「哪个版本还在发老 id」那一行日志（arkGateway.noteImageAlias）", () => {
  test("同一组合每个进程只记一次；带版本头的写版本、没带的写「≤ 2.62」；没接班不记", () => {
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      const v = { name: "2.63", code: 75, raw: "2.63+75" };
      gateway.noteImageAlias("m-a", "m-b", v);
      gateway.noteImageAlias("m-a", "m-b", v);
      gateway.noteImageAlias("m-a", "m-b", null);
      gateway.noteImageAlias("m-a", "m-a", null);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][0]).toContain("App 2.63+75");
      expect(spy.mock.calls[1][0]).toContain("≤ 2.62");
    } finally {
      spy.mockRestore();
    }
  });

  test("走 HTTP 时把请求头里的版本带进去", async () => {
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      const u = await registerUser("ver");
      fetchSpy.mockImplementation(async () => imageOk());
      await request(app)
        .post("/api/ark/images/generations")
        .set({ ...u.auth, "X-App-Version": "2.62-debug+7401" })
        .send({ model: OLD_40, prompt: "x" })
        .expect(200);
      expect(spy.mock.calls.some(([s]) => String(s).includes(`${OLD_40} → ${NEW_40}`) && String(s).includes("App 2.62-debug+7401"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
