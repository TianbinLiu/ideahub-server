// tests/arkProxy.spec.js
// 覆盖：/api/ark 火山方舟代理的四道闸门。
//
// ★ 为什么这条路由值得一份回归测试：它每一次转发都**真花钱**
//   （Seedance 一段约 1.9 元、Seedream 一张约 0.6 元），而这四道闸门的共同点是
//   「拆掉也不会有任何报错」—— 功能照常，只有账单和攻击者会发现：
//     ① 少了 requireAuth        → 任何人知道 URL 就能用我们的 key
//     ② 白名单外的上游路径可达  → 变成通用反向代理，能调方舟任意模型
//     ③ model 不校验            → 能点名任何贵模型
//     ④ asset 的域名/SSRF 不校验 → 变成公开下载代理 + 内网探测器
//     ⑤ 免费档门禁没了          → 没付过钱的用户能调高清 / 电影级（2.5 是 70 元/M，标准档的 4.7 倍，
//                                 一段 10 秒 ≈ 100 万 token），免费额度一夜之间被最贵的档吃光
//
// ★ 这些用例**不会真的打方舟**：测试环境没有 ARK_API_KEY，forward() 在发请求之前
//   就回 501；而 model / 域名 / SSRF 三道检查又都排在 forward 之前。
//   下面用 fetch 间谍把"确实没出网"这件事也断言掉——否则哪天有人把检查挪到
//   forward 之后，测试依然全绿，钱却已经花出去了。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let token; // 免费版用户（注册即 free）
let freeUserId;
let paidToken; // 已购标准套餐
let paidUserId;
let fetchSpy;

/** 注册一个新用户，返回 { token, id }。付费门禁的用例需要两个身份 */
async function registerUser(tag) {
  const name = `ark_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, id: res.body.user._id };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.ARK_API_KEY; // 明确：本套用例一律不带 key

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");

  const free = await registerUser("free");
  token = free.token;
  freeUserId = free.id;

  const paid = await registerUser("paid");
  paidToken = paid.token;
  paidUserId = paid.id;
  // 直接发套餐（绕开支付渠道）：这里要测的是门禁，不是下单链路
  const wallet = require("../src/services/tokenWallet.service");
  await wallet.buyPlan(paid.id, "std");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  // 出网间谍：任何一次 fetch 都记下来。断言"没花钱"靠它，不靠推理。
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("测试里不应该有任何出网请求");
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("鉴权闸门：花钱的端点一个都不许裸奔", () => {
  const endpoints = [
    ["post", "/api/ark/images/generations"],
    ["post", "/api/ark/contents/generations/tasks"],
    ["get", "/api/ark/contents/generations/tasks/abc123"],
    ["post", "/api/ark/chat/completions"],
    ["get", "/api/ark/asset?url=https://x.volces.com/a.mp4"],
  ];

  test.each(endpoints)("%s %s 未登录 → 401，且不出网", async (method, path) => {
    const res = await request(app)[method](path).send({ model: "doubao-seedream-5-0-260128" });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("这是白名单转发，不是通用反向代理", () => {
  // 方舟自己有一堆端点（/models、/embeddings、/batch…）。只要能穿透过去，
  // 我们的 key 就等于公开了。没在册的路径必须连路由都不存在。
  const notAllowed = [
    ["get", "/api/ark/models"],
    ["post", "/api/ark/embeddings"],
    ["post", "/api/ark/batch/chat/completions"],
    ["get", "/api/ark/contents/generations/tasks"], // 列任务：只允许按 id 查单条
  ];

  test.each(notAllowed)("%s %s → 404", async (method, path) => {
    const res = await request(app)[method](path).set(auth()).send({});
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("任务 id 只收安全字符集（不许把路径拼进上游 URL）", async () => {
    const res = await request(app).get("/api/ark/contents/generations/tasks/..%2F..%2Fmodels").set(auth());
    // 404（路由都匹配不上）或 400（匹配上了但被 TASK_ID_RE 挡下）都算挡住，
    // 唯独不能穿透到上游
    expect([400, 404]).toContain(res.status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("模型白名单：拦住「点名贵模型」", () => {
  const rejected = [
    // ★ 2.5 现在**有一个**在册的 id（doubao-seedance-2-5-260628）。这里这个版本戳
    //   不一样，仍然必须被拒 —— 白名单是精确等值，不是前缀/家族匹配。
    //   松成前缀匹配的话，方舟以后发一个更贵的 2.5-pro 就自动被放行了。
    "doubao-seedance-2-5-260601",
    "doubao-seedance-2-0-260615",
    "",
    undefined,
  ];

  test.each([["/api/ark/images/generations"], ["/api/ark/contents/generations/tasks"], ["/api/ark/chat/completions"]])(
    "%s 未在册的 model → 400，且不出网",
    async (path) => {
      for (const model of rejected) {
        const res = await request(app).post(path).set(auth()).send({ model, content: [] });
        expect(res.status).toBe(400);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  test("在册的 model 过得了这一关（没配 key 时到 501，说明已经走到 forward）", async () => {
    const res = await request(app)
      .post("/api/ark/chat/completions")
      .set(auth())
      .send({ model: "doubao-seed-2-1-turbo-260628", messages: [] });
    expect(res.status).toBe(501); // ark not configured
    expect(fetchSpy).not.toHaveBeenCalled(); // 501 是在发请求之前就返回的
  });
});

describe("产物代理不是公开下载器，也不是内网探测器", () => {
  const badHosts = [
    ["非方舟域名", "https://evil.example.com/payload.bin"],
    ["方舟域名被当成路径", "https://evil.example.com/x.volces.com/a"],
    ["方舟域名被当成前缀", "https://volces.com.evil.example/a"],
    ["明文 http", "http://x.volces.com/a.mp4"],
    ["回环", "https://127.0.0.1/a.mp4"],
    ["云元数据", "https://169.254.169.254/latest/meta-data/"],
    ["非 http 协议", "file:///etc/passwd"],
    ["空", ""],
  ];

  test.each(badHosts)("%s → 400，且不出网", async (_label, url) => {
    const res = await request(app).get(`/api/ark/asset?url=${encodeURIComponent(url)}`).set(auth());
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("免费档门禁：没付过钱只能用「极速」「草稿」出普通片（2026-10-07）", () => {
  const { SEEDANCE_2_5 } = require("../src/config/tokens");
  const MINI = "doubao-seedance-2-0-mini-260615";
  const FAST = "doubao-seedance-1-0-pro-fast-251015";
  const STD = "doubao-seedance-1-0-pro-250528";
  // ★ 1.0 两档 2026-11-24 13:00（北京时间）起停用（tokens.RETIRED_MODELS_AT）：过了那一刻免费档只剩「草稿」、
  //   1.0 的新任务一律 400 MODEL_RETIRED。凡是碰到 1.0 或免费档清单的断言都按「此刻」说话 —— 写死「极速」的话，
  //   这些用例会在那一天集体变红，而代码一个字没动。停用之后的行为另有专门的用例（拨钟验，见参数钉子那一组末尾）。
  const { isRetired, freeVideoTiers } = require("../src/config/tokens");
  const freeLabels = () => freeVideoTiers().map((t) => t.label);
  const taskBody = { model: SEEDANCE_2_5, duration: 5, content: [] };
  const post = (body, t = token) =>
    request(app).post("/api/ark/contents/generations/tasks").set({ Authorization: `Bearer ${t}` }).send(body);

  test("免费版调 2.5 → 403 PLAN_REQUIRED，理由可读、带结构化的 allowed，且不出网", async () => {
    const res = await post(taskBody);

    expect(res.status).toBe(403); // 不是 402：充值了也就成了付费用户，但这一条的原因不是「钱不够」
    expect(res.body.code).toBe("PLAN_REQUIRED");
    // ★ message 必须是一句能直接贴到界面上的话。客户端只会把它原样显示
    //   （全 app 没有地方监听 emitApiError，也没有第二份文案表）。
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toMatch(/付费套餐/);
    expect(res.body.message).toMatch(/免费版/);
    // 停用之前是「极速」「草稿」，之后只剩「草稿」（freeLabels 的 ★）
    expect(res.body.message).toContain(freeLabels().map((l) => `「${l}」`).join(""));
    expect(res.body.message).toMatch(/「草稿」/);
    // ★ 不许把模型 id 甩给用户；也不许有 ASCII 双引号（老 App 用 "message":"([^"]+)" 抠这句话，带引号会被拦腰截断）
    expect(res.body.message).not.toMatch(/seedance|doubao|"/i);
    // 英文界面不显示服务端的中文句子：能用哪几档要有结构化的一份
    expect(res.body.allowed).toEqual(freeLabels());
    if (!isRetired(FAST)) expect(res.body.allowed).toEqual(["极速", "草稿"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("被门禁拒掉时一分钱都不许扣（门禁排在扣费之前）", async () => {
    // ★ 顺序写反的话这条会红：免费用户 30 万额度扣不动 50 万，会先变成 402，
    //   真正的原因被"余额不足"盖住，用户只会一直去充值。
    const walletSvc = require("../src/services/tokenWallet.service");
    const before = await walletSvc.getWallet(freeUserId);
    await post(taskBody).expect(403);
    const after = await walletSvc.getWallet(freeUserId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });
  });

  test("付费套餐调 2.5 过得了门禁（没配 key 时到 501，说明已经走到 forward）", async () => {
    const res = await post(taskBody, paidToken);
    expect(res.status).toBe(501); // ark not configured —— 门禁与扣费都过了
    expect(fetchSpy).not.toHaveBeenCalled(); // 501 在发请求之前返回
  });

  test.each([
    ["极速 720p（不写分辨率 = 钉子补成 720p）", { model: FAST, duration: 5, content: [] }],
    ["极速 显式 720p", { model: FAST, duration: 5, resolution: "720p", content: [] }],
    ["草稿（2.0 mini · 480p）", { model: MINI, duration: 4, resolution: "480p", ratio: "9:16", content: [] }],
  ])("免费版用免费档（%s）→ 过门禁（501 = 走到 forward；1.0 停用之后是 400 MODEL_RETIRED）", async (_n, body) => {
    const res = await post(body);
    expect(res.body.code).not.toBe("PLAN_REQUIRED");
    if (isRetired(body.model)) expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "MODEL_RETIRED" });
    else expect(res.status).toBe(501);
  });

  test.each([
    ["高清（同一个 mini 模型，只差分辨率 720p）", { model: MINI, duration: 5, resolution: "720p", content: [] }],
    ["高清不写分辨率（补成 720p ⇒ 是高清不是草稿）", { model: MINI, duration: 5, content: [] }],
    ["标准（1.0 pro）", { model: STD, duration: 5, content: [] }],
    ["电影级样片第一步（2.5 · 480p · draft）", { model: SEEDANCE_2_5, duration: 4, resolution: "480p", draft: true, content: [] }],
  ])("免费版用付费档（%s）→ 403，且不出网不扣费", async (_n, body) => {
    const walletSvc = require("../src/services/tokenWallet.service");
    const before = await walletSvc.getWallet(freeUserId);
    const res = await post(body);
    if (isRetired(body.model)) {
      // 停用之后 1.0 在钉子那一关就被拒了（排在门禁前面），同样不出网、不扣费
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "MODEL_RETIRED" });
    } else {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PLAN_REQUIRED");
      expect(res.body.allowed).toEqual(freeLabels());
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await walletSvc.getWallet(freeUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  test("门禁只管出视频：免费版的出图 / 对话 / Seed3D 照常放行", async () => {
    const chat = await request(app).post("/api/ark/chat/completions").set(auth()).send({ model: "doubao-seed-2-1-turbo-260628", messages: [] });
    expect(chat.status).toBe(501);
    const img = await request(app).post("/api/ark/images/generations").set(auth()).send({ model: "doubao-seedream-4-0-250828", prompt: "x" });
    expect(img.status).toBe(501);
    const d3 = await post({ model: "doubao-seed3d-2-0-260328", content: [] });
    expect(d3.body.code).not.toBe("PLAN_REQUIRED");
    expect(d3.status).toBe(501);
  });

  test("总开关 FREE_VIDEO_GATE=off：退回改版前的口径（只有 2.5 挡免费版）", async () => {
    process.env.FREE_VIDEO_GATE = "off";
    try {
      expect((await post({ model: MINI, duration: 5, resolution: "720p", content: [] })).status).toBe(501);
      expect((await post({ model: STD, duration: 5, content: [] })).status).toBe(isRetired(STD) ? 400 : 501); // 停用与门禁开关无关
      const ultra = await post(taskBody);
      expect(ultra.status).toBe(403);
      expect(ultra.body.code).toBe("PLAN_REQUIRED");
    } finally {
      delete process.env.FREE_VIDEO_GATE;
    }
  });

  describe("videoPlanDenial（判据本身，纯函数）", () => {
    const { videoPlanDenial, isPaidUser, freeVideoTiers, RETIRED_MODELS_AT } = require("../src/config/tokens");
    const free = (o) => videoPlanDenial({ paid: false, ...o });

    test("免费档只认 (模型, 分辨率) 两个都对上、且是普通片", () => {
      // 极速那两条钉在停用前一刻（纯函数收 now）：停用之后极速本来就出局，见下面「停用时刻一到」那条
      const beforeRetire = Date.parse(RETIRED_MODELS_AT[FAST]) - 1;
      expect(free({ kind: "task", model: MINI, resolution: "480p" })).toBeNull();
      expect(free({ kind: "task", model: FAST, resolution: "720p", now: beforeRetire })).toBeNull();
      expect(free({ kind: "task", model: MINI, resolution: "720p" })).not.toBeNull();
      expect(free({ kind: "task", model: FAST, resolution: "1080p", now: beforeRetire })).not.toBeNull();
      expect(free({ kind: "task", model: MINI, resolution: undefined })).not.toBeNull();
      // 同样的 (模型, 分辨率)，只要带参考视频 / 是样片 / 样片转成片，就不是「普通片」
      expect(free({ kind: "task", model: MINI, resolution: "480p", r2v: { kind: "material" } })).not.toBeNull();
      expect(free({ kind: "task", model: MINI, resolution: "480p", draft: true })).not.toBeNull();
      expect(free({ kind: "task", model: SEEDANCE_2_5, resolution: "1080p", draftFinal: { durationSec: 4 } })).not.toBeNull();
    });

    test("真人档（MiniMax / Runway）对免费版一律不开；出图 / 对话 / 语音 / 3D 不归它管", () => {
      expect(free({ kind: "minimax_video", model: "MiniMax-Hailuo-2.3-Fast", resolution: "768P" })).not.toBeNull();
      expect(free({ kind: "runway", model: "gen4_turbo" })).not.toBeNull();
      for (const kind of ["image", "chat", "tts", "asr", "tutor_turn"]) expect(free({ kind, model: "x" })).toBeNull();
      expect(free({ kind: "task", model: "doubao-seed3d-2-0-260328" })).toBeNull();
      // 用户可控字符串查表不许顺原型链拿到东西
      expect(free({ kind: "task", model: "constructor" })).toBeNull();
    });

    test("付过钱的人一律放行；「付过钱」= 付费套餐或 paidEver（充值包也算）", () => {
      expect(videoPlanDenial({ paid: true, kind: "task", model: SEEDANCE_2_5, resolution: "720p" })).toBeNull();
      expect(videoPlanDenial({ paid: true, kind: "runway", model: "gen4_turbo" })).toBeNull();
      expect(isPaidUser({ planId: "std" })).toBe(true);
      expect(isPaidUser({ planId: "pro" })).toBe(true);
      expect(isPaidUser({ planId: "free" })).toBe(false);
      expect(isPaidUser({ planId: "free", paidEver: true })).toBe(true);
      expect(isPaidUser({ planId: "free", paidEver: "yes" })).toBe(false); // 只认布尔 true
      expect(isPaidUser({ planId: "hacker" })).toBe(false); // 认不出的套餐按免费版
      expect(isPaidUser(null)).toBe(false); // 拿不到钱包从严
    });

    test("停用时刻一到，免费档清单自动只剩「草稿」（拒绝那句话与 allowed 跟着变）", () => {
      const at = Date.parse(RETIRED_MODELS_AT[FAST]);
      expect(freeVideoTiers(at - 1).map((t) => t.label)).toEqual(["极速", "草稿"]);
      expect(freeVideoTiers(at).map((t) => t.label)).toEqual(["草稿"]);
      const after = free({ kind: "task", model: FAST, resolution: "720p", now: at });
      expect(after.allowed).toEqual(["草稿"]);
      expect(after.message).toMatch(/「草稿」/);
      expect(after.message).not.toMatch(/极速/);
      expect(free({ kind: "task", model: MINI, resolution: "480p", now: at })).toBeNull();
    });
  });
});

describe("跨仓档位表一致性（app 的报价 vs 服务端的结算，按 (模型, 分辨率) 认）", () => {
  // ★ 为什么把 app 那份**抄**在这里，而不是 fs 读 app 仓的 economy.ts：
  //   server 是独立部署的（ECS 上只有这一个仓，CI 里也没有 app 的代码）。
  //   读文件的写法在这台开发机上能过、在 CI 上只能"文件不在就跳过"——
  //   而一条会自己跳过的用例，正是本项目最怕的那种静默失败：以后有人改了 app
  //   的 mult 却没改这边，测试照样全绿，用户看到的是"报价 216k、扣了 1,015,200"。
  //   抄一份的代价是改价时要动两个仓，但那正是我们想要的提醒（payOrder.spec.js
  //   末尾的价目表用的是同一招）。
  // ⚠ 2026-08-16 按 8 月账单改过 fast 与 hd（0.3→4.2/15、1.6→23/15）。**分数形态要照抄**：
  //   写成 0.28 / 1.5333 的话这条 toEqual 会因为浮点尾数红，而那与"两仓不一致"长得一模一样。
  // ★★ 2026-10-07 起**按 (模型, 分辨率) 认**：「草稿」与「高清」是同一个模型（2.0 mini），只差 480p / 720p。
  //   只按模型建表的话两行会塌成一行 —— 草稿的免费资格就悄悄落到了高清头上（或者反过来），零报错。
  const APP_VIDEO_TIERS = [
    { id: "fast", model: "doubao-seedance-1-0-pro-fast-251015", resolution: "720p", mult: 4.2 / 15, freeOk: true, label: "极速", retireAt: "2026-11-24T13:00:00+08:00" },
    { id: "draft", model: "doubao-seedance-2-0-mini-260615", resolution: "480p", mult: 23 / 15, freeOk: true, label: "草稿" },
    { id: "std", model: "doubao-seedance-1-0-pro-250528", resolution: "720p", mult: 1, freeOk: false, label: "标准", retireAt: "2026-11-24T13:00:00+08:00" },
    { id: "hd", model: "doubao-seedance-2-0-mini-260615", resolution: "720p", mult: 23 / 15, freeOk: false, label: "高清" },
    { id: "ultra", model: "doubao-seedance-2-5-260628", resolution: "720p", mult: 4.7, freeOk: false, label: "电影级" },
  ];
  const keyOf = (t) => `${t.model}@${t.resolution}`;

  test("(模型, 分辨率) 两两不同 —— 草稿与高清不许塌成一行", () => {
    const keys = APP_VIDEO_TIERS.map(keyOf);
    expect(new Set(keys).size).toBe(APP_VIDEO_TIERS.length);
  });

  test("系数按模型逐条相等，且两边的模型集合一样（同一模型的几行系数必须一致）", () => {
    const { VIDEO_MULT } = require("../src/config/tokens");
    for (const t of APP_VIDEO_TIERS) {
      expect({ id: t.id, mult: VIDEO_MULT[t.model] }).toEqual({ id: t.id, mult: t.mult });
    }
    expect(Object.keys(VIDEO_MULT).sort()).toEqual([...new Set(APP_VIDEO_TIERS.map((t) => t.model))].sort());
  });

  test("每一行的分辨率都在服务端给这个模型放的清单里，清单里的每一档也都有 app 的一行", () => {
    const { VIDEO_RESOLUTIONS } = require("../src/config/tokens");
    const fromApp = {};
    for (const t of APP_VIDEO_TIERS) (fromApp[t.model] ||= []).push(t.resolution);
    for (const m of Object.keys(fromApp)) fromApp[m].sort();
    const server = Object.fromEntries(Object.entries(VIDEO_RESOLUTIONS).map(([m, r]) => [m, [...r].sort()]));
    expect(server).toEqual(fromApp);
  });

  test("免费档清单 = app 里 freeOk 的那几行（按 (模型, 分辨率, 档名) 逐条相等）", () => {
    const { FREE_VIDEO_ALLOW } = require("../src/config/tokens");
    const fromApp = APP_VIDEO_TIERS.filter((t) => t.freeOk).map((t) => ({ model: t.model, resolution: t.resolution, label: t.label }));
    expect(FREE_VIDEO_ALLOW.map((t) => ({ ...t }))).toEqual(fromApp);
  });

  test("停用时刻逐条相等（app 隐藏档位与服务端拒单是同一刻）", () => {
    const { RETIRED_MODELS_AT } = require("../src/config/tokens");
    const fromApp = Object.fromEntries(APP_VIDEO_TIERS.filter((t) => t.retireAt).map((t) => [t.model, t.retireAt]));
    expect({ ...RETIRED_MODELS_AT }).toEqual(fromApp);
  });

  test("在册模型与档位表一一对应（新增档位不许漏掉 ALLOWED_MODELS）", async () => {
    // 白名单是私有常量，所以从行为上验：每个档位的 (模型, 分辨率) 都得能过"在册 + 钉子"这两关。
    // 漏掉一行的症状是 400 —— 用户那边表现为"这一档永远失败"。
    // ★ 停用之后的 1.0 两行回 400 MODEL_RETIRED（码不是 VIDEO_PARAMS_NOT_ALLOWED / 不在册）：仍在册，只是不收新任务了
    const { isRetired } = require("../src/config/tokens");
    for (const t of APP_VIDEO_TIERS) {
      const res = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send({ model: t.model, duration: 5, resolution: t.resolution, content: [] });
      const want = isRetired(t.model) ? { status: 400, code: "MODEL_RETIRED" } : { status: 501, code: res.body.code };
      expect({ id: t.id, status: res.status, code: res.body.code }).toEqual({ id: t.id, ...want });
    }
  });

  test("2.5 的一段片确实超过免费版的整份新人额度（「电影级不对免费版开」的一个理由）", () => {
    const { segTokens, planOf } = require("../src/config/tokens");
    // 取**最短**的一段（窗口下限 4 秒）：连最便宜的一段都超过新人那一次额度 + 攒满的每日额度，
    // 说明"免费版怎么都用不了这一档"是事实陈述，不是营销话术（2026-10-07 起免费版不按月发了）。
    const free = planOf("free");
    expect(segTokens(4, "doubao-seedance-2-5-260628")).toBeGreaterThan(free.welcomeTokens + free.dailyCapTokens);
  });
});

describe("跨仓像素表与 480p / 1080p 价目（2026-10-07：草稿档与电影级样片）", () => {
  // 抄自 app/src/data/economy.ts 的像素表（为什么抄不 fs 读：同上）。数全部来自方舟「创建视频生成任务」的官方像素表。
  const APP_PIXELS = {
    "480p": {
      "doubao-seedance-2-0-mini-260615": { "16:9": [864, 496], "9:16": [496, 864], "4:3": [752, 560], "3:4": [560, 752], "1:1": [640, 640], "21:9": [992, 432] },
      "doubao-seedance-2-5-260628": { "16:9": [854, 480], "9:16": [480, 854], "4:3": [752, 560], "3:4": [560, 752], "1:1": [640, 640], "21:9": [992, 432] },
    },
    "1080p": {
      "doubao-seedance-2-5-260628": { "16:9": [1920, 1080], "9:16": [1080, 1920], "4:3": [1664, 1248], "3:4": [1248, 1664], "1:1": [1440, 1440], "21:9": [2206, 946] },
    },
  };
  const MINI = "doubao-seedance-2-0-mini-260615";
  const ULTRA = "doubao-seedance-2-5-260628";

  test("两张像素表逐格相等", () => {
    const { VIDEO_PIXELS } = require("../src/config/tokens");
    expect(JSON.parse(JSON.stringify(VIDEO_PIXELS))).toEqual(APP_PIXELS);
  });

  test("每秒 raw token：720p 一刀切 21,600；480p / 1080p 按格查；画幅缺省 / adaptive 按最大一格", () => {
    const { perSecTokens } = require("../src/config/tokens");
    expect(perSecTokens("doubao-seedance-1-0-pro-250528", "720p", "9:16")).toBe(21_600);
    expect(perSecTokens(MINI, "720p", "4:3")).toBe(21_600); // 改版前的口径，一个字不变
    expect(perSecTokens(MINI, "480p", "9:16")).toBe(10_044);
    expect(perSecTokens(MINI, "480p", "adaptive")).toBe(10_044);
    expect(perSecTokens(MINI, "480p", "1:1")).toBe(9_600);
    expect(perSecTokens(ULTRA, "480p", "9:16")).toBe(9_607.5);
    expect(perSecTokens(ULTRA, "480p")).toBe(10_044); // 2.5 的 480p 最大一格是 992×432
    expect(perSecTokens(ULTRA, "1080p", "9:16")).toBe(48_600);
    expect(perSecTokens(ULTRA, "1080p")).toBe((2206 * 946 * 24) / 1024); // 21:9 最大
    // 用户可控字符串：不许顺原型链拿到函数
    expect(perSecTokens(MINI, "480p", "constructor")).toBe(10_044);
  });

  test("表外的组合按官方表最大一格收 + 吼一嗓子（宁高不低；路由上够不着）", () => {
    const { perSecTokens, MAX_SEC_TOKENS } = require("../src/config/tokens");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(perSecTokens("doubao-seedance-1-0-pro-250528", "480p", "9:16")).toBe(MAX_SEC_TOKENS);
      expect(perSecTokens(MINI, "4k", "9:16")).toBe(MAX_SEC_TOKENS);
      expect(perSecTokens(MINI, "constructor")).toBe(MAX_SEC_TOKENS);
      expect(MAX_SEC_TOKENS).toBeGreaterThan(48_911);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("价目钉子（两仓逐位相等）：草稿 / 样片第一步 / 样片第二步", () => {
    const { segTokens, draftFinalTokens, DRAFT_FINAL_MULT } = require("../src/config/tokens");
    // 草稿 = 2.0 mini 480p × 23/15
    expect(segTokens(4, MINI, "480p", "9:16")).toBe(61_603);
    expect(segTokens(5, MINI, "480p", "9:16")).toBe(77_004);
    // 样片第一步 = 2.5 480p × 4.7（与电影级同一个系数：官方「Draft 视频的用量与单价均与正常 480p 一致」）
    expect(segTokens(4, ULTRA, "480p", "9:16")).toBe(180_621);
    // 样片第二步 = 2.5 1080p × 77/15（刊例 77 元/M：输出 1080p、第一步无输入视频）
    expect(DRAFT_FINAL_MULT).toBe(77 / 15);
    expect(draftFinalTokens(4, "9:16")).toBe(997_920);
    expect(draftFinalTokens(5, "9:16")).toBe(1_247_400);
    // 720p 一个字不变
    expect(segTokens(5, MINI)).toBe(165_600);
    expect(segTokens(5, MINI, "720p", "9:16")).toBe(165_600);
  });

  test("样片第二步的时长夹到 2.5 的窗口；认不出的按上限收（宁高不低）", () => {
    const { draftFinalTokens } = require("../src/config/tokens");
    expect(draftFinalTokens(31, "9:16")).toBe(draftFinalTokens(30, "9:16"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(draftFinalTokens(undefined, "9:16")).toBe(draftFinalTokens(30, "9:16"));
      expect(draftFinalTokens("abc", "9:16")).toBe(draftFinalTokens(30, "9:16"));
    } finally {
      spy.mockRestore();
    }
  });

  test("priceOf 真的读分辨率与画幅（只读 model 的话草稿会按高清收两倍多）", () => {
    const { priceOf } = require("../src/config/tokens");
    expect(priceOf("task", { model: MINI, duration: 4, resolution: "480p", ratio: "9:16" })).toBe(61_603);
    expect(priceOf("task", { model: MINI, duration: 4, resolution: "720p", ratio: "9:16" })).toBe(Math.round(4 * 21_600 * (23 / 15)));
    expect(priceOf("task", { model: ULTRA, duration: 4, resolution: "480p", ratio: "9:16", draft: true })).toBe(180_621);
    // 样片第二步：价钱只认 resolveDraftFinal 给的结论，请求体里的数（就算被塞进去）不作数
    expect(priceOf("task", { model: ULTRA, duration: 30 }, null, { draftTaskId: "cgt-x", durationSec: 4, ratio: "9:16" })).toBe(997_920);
  });
});

describe("跨仓时长窗口一致性（app 的时长按钮 vs 服务端的结算与钉子）", () => {
  // 抄自 app/src/data/economy.ts 的 VIDEO_TIERS[].minSec / maxSec（为什么抄不 fs 读：与上面档位系数那组同一个理由）。
  // ★ 2026-10-03「段时长放开」：高清 2.0-mini 到 15 秒、电影级 2.5 到 30 秒（这两个模型的协议上限），1.0 两档仍 [3,10]。
  //   两边差一格的症状是"页面按 15 秒报价、这边按 10 秒夹"（少收）或"按钮能点、请求被这边 400"（点了没反应）。
  const APP_SEC_WINDOW = {
    "doubao-seedance-1-0-pro-fast-251015": [3, 10],
    "doubao-seedance-1-0-pro-250528": [3, 10],
    "doubao-seedance-2-0-mini-260615": [4, 15],
    "doubao-seedance-2-5-260628": [4, 30],
  };

  test("两张表完全相等，且覆盖档位系数表里的每个视频模型", () => {
    const { VIDEO_SEC_WINDOW, VIDEO_MULT } = require("../src/config/tokens");
    expect(VIDEO_SEC_WINDOW).toEqual(APP_SEC_WINDOW);
    expect(Object.keys(VIDEO_SEC_WINDOW).sort()).toEqual(Object.keys(VIDEO_MULT).sort());
  });

  test("结算按窗口夹：高清 15 秒按 15 秒收、1.0 的 15 秒仍按 10 秒收（第二道保险，路由层先拒）", () => {
    const { segTokens } = require("../src/config/tokens");
    expect(segTokens(15, "doubao-seedance-2-0-mini-260615")).toBe(Math.round(15 * 21_600 * (23 / 15)));
    expect(segTokens(30, "doubao-seedance-2-5-260628")).toBe(Math.round(30 * 21_600 * 4.7));
    expect(segTokens(15, "doubao-seedance-1-0-pro-250528")).toBe(segTokens(10, "doubao-seedance-1-0-pro-250528"));
    // 缺省 5 秒：方舟不传 duration 时的默认时长，两边要对得上
    expect(segTokens(undefined, "doubao-seedance-2-0-mini-260615")).toBe(segTokens(5, "doubao-seedance-2-0-mini-260615"));
  });

  test("认不出的模型按改版前的 [3,10]（往窄的一侧退）", () => {
    const { videoSecWindow } = require("../src/config/tokens");
    expect(videoSecWindow("doubao-seedance-9-9-999999")).toEqual([3, 10]);
    expect(videoSecWindow(undefined)).toEqual([3, 10]);
  });
});

describe("纯视频任务的参数钉子（没有参考视频：生成参数钉在计价假设上）", () => {
  // ★ 计价 = 请求里的 duration × 像素 × 系数（segTokens）。代理原样转发，所以时长 / 帧数 / 分辨率
  //   与计价假设不一致的请求必须在扣费之前整句拒 —— 否则改一行客户端就能「按 5 秒的价买 30 秒」。
  const post = (body) =>
    request(app).post("/api/ark/contents/generations/tasks").set({ Authorization: `Bearer ${paidToken}` }).send(body);
  const MINI = "doubao-seedance-2-0-mini-260615";
  const ULTRA = "doubao-seedance-2-5-260628";
  // ★ 1.0 两档 2026-11-24 13:00 起停用：那之后碰到 1.0 的几行先撞「停用」（400 MODEL_RETIRED），不再走到窗口 / 分辨率那几道钉子。
  //   按「此刻」断言，别让这一组在那一天无缘无故变红（停用本身的用例在本组末尾，拨钟验）。
  const { isRetired } = require("../src/config/tokens");

  test.each([
    ["高清 15 秒（新窗口的上界）", { model: MINI, duration: 15 }],
    ["高清 4 秒（下界）", { model: MINI, duration: 4 }],
    ["标准 10 秒", { model: "doubao-seedance-1-0-pro-250528", duration: 10 }],
    ["不传 duration（钉子补成 5 秒，结算也按 5 秒）", { model: MINI }],
    ["显式 720p", { model: MINI, duration: 8, resolution: "720p" }],
    ["草稿：2.0 mini 480p", { model: MINI, duration: 4, resolution: "480p", ratio: "9:16" }],
    ["电影级样片第一步：2.5 · 480p · draft · 整数时长", { model: ULTRA, duration: 4, resolution: "480p", draft: true }],
    ["draft:false 与缺省同义", { model: MINI, duration: 5, draft: false }],
    ["三种合法条目（文字 / 图 / 音频）", { model: MINI, duration: 5, content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "https://x/y.jpg" } }, { type: "audio_url", audio_url: { url: "https://x/a.mp3" } }] }],
  ])("合规（%s）→ 过钉子走到 forward（501 = 没配 key）", async (_n, extra) => {
    const res = await post({ content: [], ...extra });
    if (isRetired(extra.model)) expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: "MODEL_RETIRED" });
    else expect(res.status).toBe(501);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("电影级 30 秒过钉子（余额够不够是下一道闸的事，但不能是被钉子拒的）", async () => {
    const res = await post({ model: ULTRA, duration: 30, content: [] });
    expect(res.body.code).not.toBe("VIDEO_PARAMS_NOT_ALLOWED");
    expect([402, 501]).toContain(res.status);
  });

  test.each([
    ["高清 16 秒（超出 4~15）", { model: MINI, duration: 16 }],
    ["高清 3 秒（2.0-mini 不收 3 秒）", { model: MINI, duration: 3 }],
    ["标准 12 秒（1.0 仍是 3~10）", { model: "doubao-seedance-1-0-pro-250528", duration: 12 }],
    ["电影级 31 秒", { model: ULTRA, duration: 31 }],
    ["duration=-1（智能时长：方舟按上界出、这边按下界收）", { model: ULTRA, duration: -1 }],
    ["duration=4.5（不是整数）", { model: MINI, duration: 4.5 }],
    ['duration="10"（字符串）', { model: MINI, duration: "10" }],
    ["带 frames（按帧数定长，与 duration 二选一）", { model: MINI, frames: 361 }],
    ["resolution=1080p（像素是 720p 的 2.25 倍）", { model: MINI, duration: 5, resolution: "1080p" }],
    ["极速 480p（1.0 只放 720p）", { model: "doubao-seedance-1-0-pro-fast-251015", duration: 5, resolution: "480p" }],
    ["标准 480p（1.0 只放 720p）", { model: "doubao-seedance-1-0-pro-250528", duration: 5, resolution: "480p" }],
    ["电影级 480p 却不是样片", { model: ULTRA, duration: 5, resolution: "480p" }],
    ["电影级 1080p（只有样片第二步出 1080p）", { model: ULTRA, duration: 5, resolution: "1080p" }],
    ["样片却是 720p", { model: ULTRA, duration: 5, resolution: "720p", draft: true }],
    ["样片不写分辨率（缺省会补 720p，样片只出 480p）", { model: ULTRA, duration: 5, draft: true }],
    ["样片不写时长（2.5 的缺省 -1 会推到 30 秒，第二步还按它收钱）", { model: ULTRA, resolution: "480p", draft: true }],
    ["样片开在高清上（只有电影级有样片）", { model: MINI, duration: 5, resolution: "480p", draft: true }],
    ['draft="true"（不是布尔）', { model: ULTRA, duration: 5, resolution: "480p", draft: "true" }],
    ["content 不是列表", { model: MINI, duration: 5, content: "hi" }],
    ["认不出的条目类型", { model: MINI, duration: 5, content: [{ type: "video", url: "https://x/v.mp4" }] }],
    ["条目没写类型", { model: MINI, duration: 5, content: [{ text: "t" }] }],
  ])("越出计价假设（%s）→ 400 整句拒，不出网、不扣费", async (_n, extra) => {
    const wallet = require("../src/services/tokenWallet.service");
    const before = await wallet.getWallet(paidUserId);
    const res = await post({ content: [], ...extra });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(isRetired(extra.model) ? "MODEL_RETIRED" : "VIDEO_PARAMS_NOT_ALLOWED");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toMatch(/没有扣费/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await wallet.getWallet(paidUserId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });
  });

  test("不在 Seedance 档位表里的任务（Seed3D 建模）不归这道钉子管", async () => {
    const res = await post({ model: "doubao-seed3d-2-0-260328", content: [] });
    expect(res.body.code).not.toBe("VIDEO_PARAMS_NOT_ALLOWED");
  });

  test("★ 缺省补齐 + 服务端钉死的字段：转发出去的是补好的那一份（不是原样转发客户端的）", async () => {
    // ★★ 不传 duration / resolution 在方舟那边是 2.5 的 -1（最长 30 秒）与 1.0 的 1080p —— 两个少收的口子。
    //   这条从「真正发出去的请求体」上验：补齐、超时 24 小时、回调地址与服务等级被剥掉。
    // 用极速（1.0：不传 resolution 的缺省是 1080p，正是要堵的那个口子）；1.0 停用之后换高清（2.0 mini）验同一件事
    const model = isRetired("doubao-seedance-1-0-pro-fast-251015") ? MINI : "doubao-seedance-1-0-pro-fast-251015";
    process.env.ARK_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "cgt-pin-fill-1" }) }));
      const res = await post({
        model,
        content: [{ type: "text", text: "t" }],
        callback_url: "https://evil.example.com/hook",
        service_tier: "flex",
        execution_expires_after: 259200,
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sent).toEqual({
        model,
        content: [{ type: "text", text: "t" }],
        duration: 5,
        resolution: "720p",
        execution_expires_after: 86400,
      });
      // 记账也是按补好的那一份：5 秒 720p
      const TokenLedger = require("../src/models/TokenLedger");
      const { segTokens } = require("../src/config/tokens");
      const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend" }).sort({ _id: -1 }).lean();
      expect(spend.delta).toBe(-segTokens(5, model, "720p"));
    } finally {
      delete process.env.ARK_API_KEY;
    }
  });

  test("样片第一步按 2.5 的 480p × 4.7 记账，并登记成样片（第二步认它）", async () => {
    process.env.ARK_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "cgt-pin-draft-1" }) }));
      const res = await post({ model: ULTRA, duration: 4, resolution: "480p", ratio: "9:16", draft: true, content: [{ type: "text", text: "t" }] });
      expect(res.status).toBe(200);
      const sent = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sent).toMatchObject({ draft: true, resolution: "480p", duration: 4, ratio: "9:16", execution_expires_after: 86400 });
      const TokenLedger = require("../src/models/TokenLedger");
      const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend" }).sort({ _id: -1 }).lean();
      expect(spend.delta).toBe(-180_621);
      const ArkVideoTask = require("../src/models/ArkVideoTask");
      const row = await ArkVideoTask.findOne({ taskId: "cgt-pin-draft-1" }).lean();
      expect(row).toMatchObject({ draft: true, durationSec: 4, resolution: "480p", costTokens: 180_621 });
      // 样片要活 8 天（7 天有效期 + 1 天）
      expect(row.expireAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(7.9 * 86400_000);
    } finally {
      delete process.env.ARK_API_KEY;
    }
  });

  test("Seed3D 任务也剥 callback_url / service_tier（同一个端点、同一个口子），但不套 execution_expires_after", async () => {
    // ★ 回调地址那个口子与模型无关：不剥的话，拿 Seed3D 也能让方舟替任何人往任意地址 POST（arkGateway.withServerTaskFields）
    process.env.ARK_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "cgt-3d-strip-1" }) }));
      const content = [{ type: "image_url", image_url: { url: "https://x/y.png" } }];
      const res = await post({ model: "doubao-seed3d-2-0-260328", content, callback_url: "https://evil.example.com/hook", service_tier: "flex" });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ model: "doubao-seed3d-2-0-260328", content });
    } finally {
      delete process.env.ARK_API_KEY;
    }
  });

  test("停用时刻一到：标准 / 极速新任务 400 MODEL_RETIRED（不扣费）；别的档照常", async () => {
    const { RETIRED_MODELS_AT } = require("../src/config/tokens");
    const { signToken } = require("../src/utils/jwt");
    const User = require("../src/models/User");
    const at = Date.parse(RETIRED_MODELS_AT["doubao-seedance-1-0-pro-fast-251015"]);
    // ★ 拨钟：JWT 的有效期也按 Date.now 判，所以在拨过去的那一刻现签一张（7 天前签的那张在 11-24 早过期了）
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(at + 60_000);
    try {
      const t = signToken(await User.findById(paidUserId).lean());
      const send = (body) => request(app).post("/api/ark/contents/generations/tasks").set({ Authorization: `Bearer ${t}` }).send(body);
      for (const model of ["doubao-seedance-1-0-pro-fast-251015", "doubao-seedance-1-0-pro-250528"]) {
        const res = await send({ model, duration: 5, content: [] });
        expect({ model, status: res.status, code: res.body.code }).toEqual({ model, status: 400, code: "MODEL_RETIRED" });
        expect(res.body.message).toMatch(/停止服务/);
        expect(res.body.message).toMatch(/没有扣费/);
      }
      expect((await send({ model: MINI, duration: 4, resolution: "480p", content: [] })).status).toBe(501);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("停用前一刻照常收（钉子按时刻判，不是按日期判）", async () => {
    const { isRetired, retiredDenial, RETIRED_MODELS_AT } = require("../src/config/tokens");
    const at = Date.parse(RETIRED_MODELS_AT["doubao-seedance-1-0-pro-250528"]);
    expect(at).toBe(Date.parse("2026-11-24T05:00:00Z")); // 北京时间 13:00 = UTC 05:00（方舟 14:00 停服，提前一小时）
    expect(isRetired("doubao-seedance-1-0-pro-250528", at - 1)).toBe(false);
    expect(isRetired("doubao-seedance-1-0-pro-250528", at)).toBe(true);
    expect(isRetired(MINI, at + 365 * 86400_000)).toBe(false);
    expect(retiredDenial("doubao-seedance-1-0-pro-fast-251015", at - 1)).toBeNull();
    // 句子里不写模型 id、不带 ASCII 双引号（老 App 的正则抠法）
    expect(retiredDenial("doubao-seedance-1-0-pro-fast-251015", at)).not.toMatch(/doubao|"/);
  });
});

describe("电影级样片第二步（480p 样片 → 1080p 成片，resolveDraftFinal）", () => {
  // ★★ 这一组盯死三件零症状的事：① 价钱只认我们登记的样片时长 × 1080p × 77/15（请求体里一个数都不信）；
  //   ② 只认本人、经我们这里出的样片（同一把方舟 key，方舟认 id 不认人）；③ 方舟规定沿用样片的那些参数，
  //   重传一个就是异步失败 —— 在这里同步拒掉、一分钱不花。
  const ArkVideoTask = require("../src/models/ArkVideoTask");
  const TokenLedger = require("../src/models/TokenLedger");
  const walletSvc = require("../src/services/tokenWallet.service");
  const { draftFinalTokens } = require("../src/config/tokens");
  const ULTRA = "doubao-seedance-2-5-260628";
  const asPaid = () => ({ Authorization: `Bearer ${paidToken}` });
  const finalBody = (id, extra = {}) => ({ model: ULTRA, content: [{ type: "draft_task", draft_task: { id } }], ...extra });

  /** 方舟替身：GET 查样片（按剧本回），POST 受理成片 */
  let draftView;
  let createCalls;
  function mockArk() {
    createCalls = [];
    fetchSpy.mockImplementation(async (url, init) => {
      if (!init || init.method === "GET") {
        return { status: draftView.status ?? 200, text: async () => JSON.stringify(draftView.body) };
      }
      createCalls.push(JSON.parse(init.body));
      return { status: 200, text: async () => JSON.stringify({ id: `cgt-final-${createCalls.length}-${Date.now()}` }) };
    });
  }

  async function seedDraft(taskId, userId, extra = {}) {
    await ArkVideoTask.deleteOne({ taskId });
    return ArkVideoTask.create({ userId, taskId, model: ULTRA, durationSec: 4, ratio: "adaptive", resolution: "480p", draft: true, ...extra });
  }

  beforeAll(async () => {
    await walletSvc.credit(paidUserId, 50_000_000, "recharge", "测试预置额度");
  });

  beforeEach(async () => {
    process.env.ARK_API_KEY = "test-key";
    await TokenLedger.deleteMany({ user: paidUserId, reason: { $in: ["ark_spend", "ark_refund"] } });
    draftView = { body: { id: "x", model: ULTRA, status: "succeeded", ratio: "9:16", resolution: "480p", duration: 4, created_at: Math.floor(Date.now() / 1000) - 60 } };
    mockArk();
  });

  afterEach(() => {
    delete process.env.ARK_API_KEY;
  });

  test("本人的样片 → 请求体重写成最小形状、按 样片时长 × 1080p × 77/15 扣、记下是哪条样片转的", async () => {
    await seedDraft("cgt-draft-ok-1", paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(finalBody("cgt-draft-ok-1", { resolution: "1080p", watermark: true, callback_url: "https://evil.example.com/h", execution_expires_after: 3600 }));
    expect(res.status).toBe(200);
    // 先 GET 查样片（不计费），再 POST 一发成片
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      model: ULTRA,
      content: [{ type: "draft_task", draft_task: { id: "cgt-draft-ok-1" } }],
      resolution: "1080p",
      watermark: false,
      execution_expires_after: 86400,
    });
    const expected = draftFinalTokens(4, "9:16");
    expect(expected).toBe(997_920);
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend" }).sort({ _id: -1 }).lean();
    expect(spend.delta).toBe(-expected);
    const finalRow = await ArkVideoTask.findOne({ draftOf: "cgt-draft-ok-1" }).lean();
    expect(finalRow).toMatchObject({ durationSec: 4, ratio: "9:16", resolution: "1080p", draft: false, costTokens: expected });
  });

  test("时长只认我们登记的那一份：方舟回的 duration 再大也不作数；登记没有才退方舟的整数秒", async () => {
    await seedDraft("cgt-draft-dur-1", paidUserId, { durationSec: 5 });
    draftView.body.duration = 30;
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-dur-1")).expect(200);
    let spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend" }).sort({ _id: -1 }).lean();
    expect(spend.delta).toBe(-draftFinalTokens(5, "9:16"));

    await seedDraft("cgt-draft-dur-2", paidUserId, { durationSec: undefined });
    draftView.body.duration = 6;
    draftView.body.ratio = "adaptive"; // 认不出的画幅 → 按 1080p 最大一格收（宁高不低）
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-dur-2")).expect(200);
    spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend" }).sort({ _id: -1 }).lean();
    expect(spend.delta).toBe(-draftFinalTokens(6, undefined));
  });

  test.each([
    ["别人的样片", async () => seedDraft("cgt-draft-n-1", freeUserId), "cgt-draft-n-1", {}],
    ["不是样片（普通任务的 id）", async () => seedDraft("cgt-draft-n-2", paidUserId, { draft: false }), "cgt-draft-n-2", {}],
    ["没登记过的 id", async () => null, "cgt-draft-n-3", {}],
    ["重传时长（方舟规定沿用样片）", async () => seedDraft("cgt-draft-n-4", paidUserId), "cgt-draft-n-4", { duration: 4 }],
    ["重传画幅", async () => seedDraft("cgt-draft-n-5", paidUserId), "cgt-draft-n-5", { ratio: "9:16" }],
    ["要 720p（第二步只出 1080p）", async () => seedDraft("cgt-draft-n-6", paidUserId), "cgt-draft-n-6", { resolution: "720p" }],
    ["这一发又标成样片", async () => seedDraft("cgt-draft-n-7", paidUserId), "cgt-draft-n-7", { draft: true }],
    ["模型不是电影级", async () => seedDraft("cgt-draft-n-8", paidUserId), "cgt-draft-n-8", { model: "doubao-seedance-2-0-mini-260615" }],
  ])("拒（%s）→ 400 DRAFT_FINAL_NOT_ALLOWED，不受理、不扣费", async (_n, seed, id, extra) => {
    await seed();
    const before = await walletSvc.getWallet(paidUserId);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody(id, extra));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DRAFT_FINAL_NOT_ALLOWED");
    expect(res.body.message).toMatch(/没有扣费/);
    expect(createCalls).toHaveLength(0);
    const after = await walletSvc.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  test("样片条目旁边再塞一条提示词 / 视频 → 400（只能有那一条，而且不许白查一次 Cloudinary）", async () => {
    await seedDraft("cgt-draft-mix-1", paidUserId);
    for (const extraItem of [
      { type: "text", text: "再加一句" },
      { type: "video_url", role: "reference_video", video_url: { url: "https://res.cloudinary.com/demo/video/upload/v1/x.mp4" } },
    ]) {
      const body = finalBody("cgt-draft-mix-1");
      body.content.push(extraItem);
      const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(body);
      expect({ type: extraItem.type, status: res.status, code: res.body.code }).toEqual({ type: extraItem.type, status: 400, code: "DRAFT_FINAL_NOT_ALLOWED" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("样片条目的形状不对（多一个键 / id 带路径）→ 400", async () => {
    await seedDraft("cgt-draft-shape-1", paidUserId);
    for (const item of [
      { type: "draft_task", draft_task: { id: "cgt-draft-shape-1", seed: 1 } },
      { type: "draft_task", draft_task: { id: "../models" } },
      { type: "draft_task", draft_task: { id: "cgt-draft-shape-1" }, role: "x" },
      { draft_task: { id: "cgt-draft-shape-1" } },
    ]) {
      const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send({ model: ULTRA, content: [item] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("DRAFT_FINAL_NOT_ALLOWED");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("过了有效期（7 天差 1 小时）→ 400；按我们的登记与方舟的 created_at 里更早的那个算", async () => {
    const { DRAFT_FINAL_WINDOW_MS } = require("../src/services/arkVideoTask.service");
    expect(DRAFT_FINAL_WINDOW_MS).toBe(7 * 86400_000 - 3600_000);
    await seedDraft("cgt-draft-old-1", paidUserId);
    await ArkVideoTask.collection.updateOne({ taskId: "cgt-draft-old-1" }, { $set: { createdAt: new Date(Date.now() - DRAFT_FINAL_WINDOW_MS - 1000) } });
    let res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-old-1"));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/7 天/);
    expect(fetchSpy).not.toHaveBeenCalled(); // 登记就已经过期：连方舟都不用问

    // 登记看着还新，但方舟说它是 7 天前建的 → 照样拒
    await seedDraft("cgt-draft-old-2", paidUserId);
    draftView.body.created_at = Math.floor((Date.now() - DRAFT_FINAL_WINDOW_MS - 60_000) / 1000);
    res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-old-2"));
    expect(res.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  test("方舟说样片还没成 / 找不到 → 400；方舟查不通 → 502；都不扣费", async () => {
    await seedDraft("cgt-draft-st-1", paidUserId);
    draftView.body.status = "running";
    let res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-st-1"));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/running/);

    draftView = { status: 404, body: { error: { code: "ResourceNotFound" } } };
    res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-st-1"));
    expect(res.status).toBe(400);

    draftView = { status: 500, body: { error: { code: "InternalServiceError" } } };
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-st-1"));
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/没有扣费/);
    expect(createCalls).toHaveLength(0);
    expect(await TokenLedger.countDocuments({ user: paidUserId, reason: "ark_spend" })).toBe(0);
  });

  test("免费版拿着自己的样片（比如以前付过费时出的）也转不了 → 403 PLAN_REQUIRED（与其它出片同一道门）", async () => {
    await seedDraft("cgt-draft-free-1", freeUserId);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(auth()).send(finalBody("cgt-draft-free-1"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(createCalls).toHaveLength(0);
  });

  test("没配 key → 501（与其它出片同口径），不扣费", async () => {
    delete process.env.ARK_API_KEY;
    await seedDraft("cgt-draft-nokey-1", paidUserId);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(finalBody("cgt-draft-nokey-1"));
    expect(res.status).toBe(501);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("跨仓出图价目一致性（app 的报价 vs 服务端的结算）", () => {
  // ★ 这一组盯的是 2026-08-11 之前真实存在的缺口：`priceOf` 拿到了请求体却不读 model，
  //   于是**顶档按最低档收费**（三档差 3 倍）。它没有任何症状 —— 用户无感、界面无错、
  //   测试全绿，只有火山账单知道。所以必须由测试从外面把"真的读了 model"钉住。
  //
  // 抄自 app/src/data/economy.ts 的 IMAGE_TIERS + IMAGE_TOKENS_BY_MODEL。
  // 为什么抄而不是 fs 读 app 仓：理由同上面视频那组（server 独立部署，CI 里没有 app 的代码；
  // 会自己跳过的用例是本项目最怕的静默失败）。
  const APP_IMAGE_TIERS = [
    { id: "sketch", model: "doubao-seedream-4-0-250828", tokens: 13_333 }, // 0.20 元/张
    { id: "studio", model: "doubao-seedream-4-5-251128", tokens: 16_667 }, // 0.25 元/张
    { id: "master", model: "doubao-seedream-5-0-pro-260628", tokens: 40_000 }, // 0.60 元/张
  ];

  /** 老客户端（已装机的 APK）还在发的出图模型：新包的 MODELS.image 已经改成 4.0，
   *  但装出去的那些改不了。老包对它的报价是 economy.IMAGE_TOKENS = 13,300 */
  const LEGACY_IMAGE_MODEL = "doubao-seedream-5-0-260128";
  const LEGACY_IMAGE_TOKENS = 13_300;

  test("两张表的 key 集合与数值完全相等", () => {
    const { IMAGE_TOKENS_BY_MODEL } = require("../src/config/tokens");
    const fromApp = Object.fromEntries(APP_IMAGE_TIERS.map((t) => [t.model, t.tokens]));
    // toEqual 是**双向**比较：这边多一个模型、少一个模型、或者数值差一点，都会红
    expect(IMAGE_TOKENS_BY_MODEL).toEqual(fromApp);
  });

  test("priceOf 真的按 model 定价（写成一口价这条就红）", () => {
    const { priceOf } = require("../src/config/tokens");
    for (const t of APP_IMAGE_TIERS) {
      expect({ id: t.id, cost: priceOf("image", { model: t.model }) }).toEqual({ id: t.id, cost: t.tokens });
    }
    // ★ 再钉一条"三个价互不相同"：只有上面那三条逐条断言的话，把实现换成
    //   「常量恰好等于其中一档」会红两条 —— 而这里要证明的不是"某一档对不对"，
    //   是"根本有没有读 model"。互不相同是那件事最直接的形状。
    const distinct = new Set(APP_IMAGE_TIERS.map((t) => priceOf("image", { model: t.model })));
    expect(distinct.size).toBe(APP_IMAGE_TIERS.length);
  });

  test("档位越高越贵（顺序倒挂 = 用户为更好的图付更少，账单我们自己吃）", () => {
    const { priceOf } = require("../src/config/tokens");
    const costs = APP_IMAGE_TIERS.map((t) => priceOf("image", { model: t.model }));
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  test("认不出的出图模型：按最贵档收 + 吼一嗓子，既不白送也不抛", () => {
    // ★ 三个选项的后果写在 config/tokens.imageTokensOf 的注释里：
    //   按最便宜收 = 白送且永远没人发现；throw = billedForward 变 500，出图整条全挂；
    //   按最贵收 = 少收是隐形的、多收当天就被投诉，方向选对了。
    const { priceOf, IMAGE_TOKENS_BY_MODEL } = require("../src/config/tokens");
    const max = Math.max(...Object.values(IMAGE_TOKENS_BY_MODEL));
    const min = Math.min(...Object.values(IMAGE_TOKENS_BY_MODEL));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(priceOf("image", { model: "doubao-seedream-9-9-999999" })).toBe(max);
      expect(priceOf("image", {})).toBe(max);
      // ★ model 是用户可控的字符串：拿普通对象查表时 `constructor`/`toString` 会顺着
      //   原型链返回一个**函数**，那个"价格"交给 Mongo 的 $inc 就是 500。查价表用 Map。
      expect(priceOf("image", { model: "constructor" })).toBe(max);
      expect(priceOf("image", { model: "toString" })).toBe(max);
      expect(max).toBeGreaterThan(min); // 兜底值确实是"最贵"而不是碰巧
      // 兜底必须留痕（铁律八）：静默兜底 = 有人扩了白名单忘了定价，而没人会知道
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("三档的出图模型都在册（漏一行的症状是这一档永远 400）", async () => {
    // 白名单是私有常量，所以从行为上验：501 = 已经走到 forward，说明在册与扣费都过了。
    for (const t of APP_IMAGE_TIERS) {
      const res = await request(app)
        .post("/api/ark/images/generations")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send({ model: t.model, prompt: "x" });
      expect({ id: t.id, status: res.status }).toEqual({ id: t.id, status: 501 });
    }
    expect(fetchSpy).not.toHaveBeenCalled(); // 501 在发请求之前返回
  });

  test("老客户端的出图模型仍在册且按老价收（已装机的 APK 改不了 model）", async () => {
    // ★ 把它从白名单里删掉不是"降级"，是那批用户**出图整条全挂 400**：补设定帧 /
    //   三套方案的首尾帧 / AI 封面全走这条路，而客户端把 400 当敏感词处理，连重试都没有。
    const { priceOf } = require("../src/config/tokens");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 有价，且是**老包自己报的那个价** —— 这次改价对老用户必须是零影响。
      // 落到"认不出"的兜底上就是老客户端被按顶档多扣 3 倍（40,000 vs 报价 13,300）。
      expect(priceOf("image", { model: LEGACY_IMAGE_MODEL })).toBe(LEGACY_IMAGE_TOKENS);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const res = await request(app)
      .post("/api/ark/images/generations")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send({ model: LEGACY_IMAGE_MODEL, prompt: "x" });
    expect(res.status).toBe(501);
  });
});

describe("健康端点", () => {
  test("不需要登录，且只说配没配、不泄露 key", async () => {
    const res = await request(app).get("/api/ark/health").expect(200);
    // imageGroups：这台服务器有没有组图任务（App 据此决定九宫格分镜能不能用），能力位、不是秘密
    // res480 / draftMode / failRefund / freeVideo：2026-10-07 的四个能力位（老服务端没有 = App 把对应的东西藏起来）
    expect(res.body).toEqual({
      ok: true,
      ark: false,
      imageGroups: true,
      res480: true,
      draftMode: true,
      failRefund: true,
      // 停用的档自动出局（1.0 极速 2026-11-24 13:00 起就不在这里了）：按「此刻」断言，别让这条在那一天变红
      freeVideo: [
        { label: "极速", model: "doubao-seedance-1-0-pro-fast-251015", resolution: "720p" },
        { label: "草稿", model: "doubao-seedance-2-0-mini-260615", resolution: "480p" },
      ].filter((t) => !require("../src/config/tokens").isRetired(t.model)),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|Bearer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("r2v（白模模板）：只准已登记模板 URL，按 2.8 系数计价", () => {
  // ★ 为什么钉这一组：priceOf 的 task 分支不读 content，而 r2v 的官方计费要把
  //   **输入视频时长**也算进 token。resolveR2v 是唯一挡在中间的闸门 ——
  //   拆掉/写松它的后果全都零症状：任意 URL 白嫖（按纯任务价结算，输入一分不收）、
  //   伪造 URL 蹭价、blocked 模板照常可用。所以每一条边界都从行为上钉住。
  const { SEEDANCE_2_5, VIDEO_MULT_R2V, r2vTokens } = require("../src/config/tokens");
  const BranchTemplate = require("../src/models/BranchTemplate");
  const BranchTemplateTrial = require("../src/models/BranchTemplateTrial");
  const walletSvc = require("../src/services/tokenWallet.service");

  // 模板作者 = 外层的付费用户（2.5 是 paidOnly，作者试炼也得过套餐门禁）
  let publishedTpl; // 已发布，10s
  let pendingTpl; // 作者自己的待发布（试炼路径）
  let blockedTpl; // 平台已下架

  /** 造一条服务端登记（绕开 HTTP：这里测的是 ark 代理，不是建模板链路） */
  async function seedTemplate(ownerId, tag, status) {
    return BranchTemplate.create({
      ownerId,
      authorName: "seed",
      title: `tpl-${tag}`,
      recipe: { styleHint: "", beats: ["b"], durationSec: 5, videoTier: "ultra", framePrompt: "" },
      refVideo: {
        url: `https://res.cloudinary.com/demo/video/upload/v1/ideahub/template-videos/${ownerId}-${tag}.mp4`,
        durationSec: 10,
        width: 720,
        height: 1280,
        bytes: 5_000_000,
        cloudinaryPublicId: `ideahub/template-videos/${ownerId}-${tag}`,
      },
      status,
      provenAt: null,
    });
  }

  /** 拼一个带参考视频的 2.5 任务体 —— 形状 = App 侧 BLOCKOUT_TASK 的真实请求
   *  （edit + duration:-1 + adaptive 三件套是计价公式的前提，服务端已把它们钉死，
   *  见 resolveR2v；不带就 400，所以测试体必须带全） */
  function r2vBody(url, model = SEEDANCE_2_5) {
    return {
      model,
      content: [
        { type: "text", text: "把视频里的红色小人替换成角色" },
        { type: "video_url", role: "reference_video", video_url: { url } },
      ],
      omni_reference_task_type: "edit",
      duration: -1,
      ratio: "adaptive",
    };
  }

  beforeAll(async () => {
    publishedTpl = await seedTemplate(paidUserId, "1001", "published");
    pendingTpl = await seedTemplate(paidUserId, "1002", "pending");
    blockedTpl = await seedTemplate(paidUserId, "1003", "blocked");
    // ★ 先充够：这一组里「试炼闸端到端」那条是**真受理**（200），钱不退 ——
    //   一段 r2v 就是 120 万 token，标准套餐的 200 万撑不到本组末尾，
    //   后面的用例会莫名其妙地收到 402 而不是它要测的那个码。
    await walletSvc.credit(paidUserId, 50_000_000, "recharge", "测试预置额度");
  });

  test("未登记的 URL → 400 整句拒，且不出网、不扣费（堵白嫖与蹭价）", async () => {
    const before = await walletSvc.getWallet(freeUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send(r2vBody("https://example.com/x.mp4"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(typeof res.body.message).toBe("string"); // 整句可显示，不是错误码天书
    expect(res.body.message).toMatch(/登记/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await walletSvc.getWallet(freeUserId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });
  });

  // 2026-10-05 起 2.0-mini 也在 r2v 价目表里（高清开了片段重拍 + 参考视频出片），换成确实不在表里的 1.0 标准档
  test("model 不在 r2v 价目表（1.0 标准档）→ 400，绝不静默按纯任务价结算", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(publishedTpl.refVideo.url, "doubao-seedance-1-0-pro-250528"));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("多条 reference_video → 400（不是我们客户端会拼出的形状）", async () => {
    const body = r2vBody(publishedTpl.refVideo.url);
    body.content.push({ type: "video_url", role: "reference_video", video_url: { url: publishedTpl.refVideo.url } });
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(body);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ★★ 参数钉死组：计价是 (登记时长×2)×720p，成立前提是 edit + duration:-1 + 720p ——
  //   代理原样转发，不钉的话改一行客户端就能按 4s 模板的价买 30s/1080p 的产出
  //   （2026-08-14 对抗审查发现的高危：计费与转发参数解耦）。
  test.each([
    ["reference 子任务", (b) => { b.omni_reference_task_type = "reference"; }],
    ["缺 omni_reference_task_type", (b) => { delete b.omni_reference_task_type; }],
    ["duration=30（[4,30] 合法区间也不行）", (b) => { b.duration = 30; }],
    ["resolution=1080p", (b) => { b.resolution = "1080p"; }],
    ["ratio=16:9（钉 adaptive）", (b) => { b.ratio = "16:9"; }],
    // 方舟在 r2v edit 路真收 generate_audio（2026-08-15 探针实测）。这一格现在钉的是
    // 「与该模型的支持情况一致」（见下面那一组），非布尔值一律不认
    ["generate_audio 是个字符串（不是布尔）", (b) => { b.generate_audio = "yes"; }],
  ])("r2v 生成参数越出计价假设（%s）→ 400，不出网不扣费", async (_name, mutate) => {
    const body = r2vBody(publishedTpl.refVideo.url);
    mutate(body);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("不带 role 的 video_url 条目 → 400（role 是客户端可控字段，去掉它不能绕过注册表按纯任务价放行）", async () => {
    const body = r2vBody(publishedTpl.refVideo.url);
    body.content[1] = { type: "video_url", video_url: { url: "https://evil.example.com/any.mp4" } };
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("blocked 模板 → 400（事后治理要有牙齿：下架就是不能再用）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(blockedTpl.refVideo.url));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("pending 模板：非作者 → 400；作者本人 → 过闸门（501 = 走到 forward，试炼路径通）", async () => {
    // 非作者（free 用户）拿到 URL 也不能蹭未发布的模板
    const other = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send(r2vBody(pendingTpl.refVideo.url));
    expect(other.status).toBe(400);

    // 作者本人：这正是发布前「用自己的模板出一次片」的试炼路
    const mine = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(pendingTpl.refVideo.url));
    expect(mine.status).toBe(501); // 没配 key：闸门与扣费都过了才到 forward
  });

  test("免费用户走 r2v 照样撞免费档门禁（带参考视频的出片只对付过钱的人开放，不是旁路）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send(r2vBody(publishedTpl.refVideo.url));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("已登记 → 按 (输入+输出)×21600×2.8 扣费，流水 memo 带模板 id（501 后原路退回）", async () => {
    const TokenLedger = require("../src/models/TokenLedger");
    const expected = r2vTokens(10, SEEDANCE_2_5); // 登记 10s ⇒ (10+10)×21600×2.8 = 1,209,600
    expect(expected).toBe(1_209_600); // 公式实测钉死（A3 两发分毫不差），改公式必须先改这条

    const before = await walletSvc.getWallet(paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(publishedTpl.refVideo.url));
    expect(res.status).toBe(501); // 无 key：扣费发生在 forward 之前，501 后 W2 原路退回

    const after = await walletSvc.getWallet(paidUserId);
    // 扣的是 r2v 价（先扣 plan 再扣 addon），501 = 没受理 ⇒ 按扣的那两桶原样退回（2026-10-07 起 tokenWallet.refundSplit）——
    //   两桶各自复原。★ 原来这里断言「退回进 addon、构成移动」：那是改版前的口径，只因为这个账号此刻 plan 恰好是 0 才一直绿着
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });

    // 流水必须带 r2v 标记（对账时把白模的钱从纯任务里分出来靠它）。
    // 按 memo 里的模板 id 查而不是按时间排序：金额相同的两笔（试炼那发也是 1,209,600）
    // 在同一毫秒落库时排序不稳，按 id 查没有这个坑
    const spend = await TokenLedger.findOne({
      user: paidUserId,
      reason: "ark_spend",
      memo: new RegExp(`r2v tpl:${String(publishedTpl._id)}`),
    }).lean();
    expect(spend).toBeTruthy();
    expect(spend.delta).toBe(-expected);
  });

  test("试炼闸端到端：作者的 r2v 任务受理 → 轮询 succeeded → provenAt 被置上", async () => {
    // 这一条要走完整条证据链，所以放行出网（fetch 全程是假的，不真花钱）
    process.env.ARK_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ id: "cgt-trial-0001" }),
      }));
      const createRes = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send({ ...r2vBody(pendingTpl.refVideo.url), callback_url: "https://evil.example.com/h" });
      expect(createRes.status).toBe(200);
      // r2v 这一发同样套上服务端钉死的字段（24 小时超时、剥掉回调地址）—— 唯一实现在 arkGateway.withServerTaskFields
      const sentR2v = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(sentR2v.execution_expires_after).toBe(86400);
      expect(sentR2v.callback_url).toBeUndefined();

      // 受理即落追踪：{taskId, templateId, userId} —— 试炼的证据由服务端自己记
      const trial = await BranchTemplateTrial.findOne({ taskId: "cgt-trial-0001" }).lean();
      expect(String(trial.templateId)).toBe(String(pendingTpl._id));
      expect(String(trial.userId)).toBe(String(paidUserId));
      // 追踪里同时记下这一发用的出片模型（试炼成功时要写进模板的 provenModels）
      expect(trial.model).toBe(r2vBody(pendingTpl.refVideo.url).model);

      // 轮询到 succeeded：provenAt 置上（发起人 = 模板作者），追踪记录清掉
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ id: "cgt-trial-0001", status: "succeeded" }),
      }));
      const poll = await request(app)
        .get("/api/ark/contents/generations/tasks/cgt-trial-0001")
        .set({ Authorization: `Bearer ${paidToken}` });
      expect(poll.status).toBe(200);

      const tpl = await BranchTemplate.findById(pendingTpl._id).lean();
      expect(tpl.provenAt).toBeTruthy();
      // 「在哪个模型上跑通的」一并记下：就是这一发任务的 model，不多不少
      expect(tpl.provenModels).toEqual([r2vBody(pendingTpl.refVideo.url).model]);
      expect(await BranchTemplateTrial.findOne({ taskId: "cgt-trial-0001" }).lean()).toBeNull();

      // 再跑通一次（provenAt 早就置上了）：模型照记、不重复，provenAt 不被改写
      const provenAt0 = tpl.provenAt.getTime();
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ id: "cgt-trial-0002" }),
      }));
      const again = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send(r2vBody(pendingTpl.refVideo.url));
      expect(again.status).toBe(200);
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ id: "cgt-trial-0002", status: "succeeded" }),
      }));
      await request(app)
        .get("/api/ark/contents/generations/tasks/cgt-trial-0002")
        .set({ Authorization: `Bearer ${paidToken}` });
      const tpl2 = await BranchTemplate.findById(pendingTpl._id).lean();
      expect(tpl2.provenModels).toEqual([r2vBody(pendingTpl.refVideo.url).model]);
      expect(tpl2.provenAt.getTime()).toBe(provenAt0);
    } finally {
      delete process.env.ARK_API_KEY;
    }
  });

  test("provenModelsOf：记过的原样出；存量（有 provenAt、没记过模型）按当时唯一的 r2v 模型出；没试炼过是空数组", () => {
    const of = (doc) => BranchTemplate.provenModelsOf(doc);
    expect(of({ provenAt: new Date(), provenModels: ["m-a", "m-b"] })).toEqual(["m-a", "m-b"]);
    // 存量：上线前置上的 provenAt，那一发只可能跑在 2.5 上（写死的历史事实，不跟着常量走）
    expect(of({ provenAt: new Date() })).toEqual(["doubao-seedance-2-5-260628"]);
    expect(of({ provenAt: new Date(), provenModels: [] })).toEqual(["doubao-seedance-2-5-260628"]);
    expect(of({ provenAt: null })).toEqual([]);
    expect(of({ provenAt: null, provenModels: [] })).toEqual([]);
    expect(of(null)).toEqual([]);
  });

  // ── 套用闸：模板视频自己得过方舟窗口（2026-08-16 补的结构性缺口）────────
  //
  // ★★ 在此之前，命中已登记模板的这条分支**完全不复核时长**（未登记素材那条分支反而有），
  //   于是一段 3.712s 的坏模板在我们这边一路绿灯，撞的是方舟那句英文
  //   `InvalidParameter.TaskTypeConstraint … 4 to 30 seconds`。钱这一侧本来就安全
  //   （W2 会退未受理的那一笔），但用户看到的是一句天书，而且他根本不知道该换个模板。
  test("★★ 已登记模板的**真实时长** 3.712s → deny，一分钱不动（别让套用者去撞方舟的英文 400）", async () => {
    const walletSvc2 = require("../src/services/tokenWallet.service");
    const bad = await seedTemplate(paidUserId, "1099", "published");
    // 回填脚本跑完之后的样子：锚点还是 10（那是已发布模板的报价，不许动），真值是 3.712
    await BranchTemplate.updateOne({ _id: bad._id }, { $set: { "refVideo.realDurationSec": 3.712 } });

    const before = await walletSvc2.getWallet(paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(bad.refVideo.url));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(res.body.message).toMatch(/约 3\.7 秒/);
    expect(res.body.message).toMatch(/没有扣费/);
    const after = await walletSvc2.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
    expect(fetchSpy).not.toHaveBeenCalled(); // 拒在扣费与转发之前
  });

  test("★★ 存量模板（**没有** realDurationSec 这一位）照常放行 —— 后加的字段判否定", async () => {
    // ★★ 这条防的是"用肯定式判新字段"：那会把所有存量模板（那一位是 undefined）
    //   整批判成坏的 —— 全站白模模板突然都用不了了，而且理由是一句关于时长的话，
    //   谁都对不上号。publishedTpl 就是这种老形状（只有 durationSec: 10）。
    const doc = await BranchTemplate.findById(publishedTpl._id).lean();
    expect(doc.refVideo.realDurationSec).toBeUndefined(); // 前提：它真的没有这一位
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(publishedTpl.refVideo.url));
    expect(res.status).toBe(501); // 501 = 闸门与扣费都过了，只是没配 key
  });

  // ── 音频钉子：从「必须 false」改成「与该模型的支持情况一致」──────────
  // ★ 为什么改：2026-08-15 费用中心逐行核对 —— 同素材有声/无声两发的用量与单价
  //   **逐位相同**（各 209.71 千 tokens × ¥0.042/千），计费单元里也没有给音频单列的
  //   条目 ⇒ 开音频零额外成本，「按无声价买有声产出」这件事根本不存在。
  //   原来那条钉子是"这一版不开方舟音频"的代码表达，账单核完就该放开
  //   （放开与价目同一个提交 —— 而这次价目一个字都没改，正说明它确实免费）。
  test("2.x 档的 r2v 允许 generate_audio: true（501 = 钉子放行、走到 forward）", async () => {
    const body = r2vBody(publishedTpl.refVideo.url);
    body.generate_audio = true;
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(body);
    expect(res.status).toBe(501);
  });

  test("generate_audio: false / 缺省 一直都放行（老客户端不受影响）", async () => {
    for (const patch of [{ generate_audio: false }, {}]) {
      const res = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send({ ...r2vBody(publishedTpl.refVideo.url), ...patch });
      expect(res.status).toBe(501);
    }
  });

  test("1.x 档不支持音频（能力表是唯一判据，别让用户以为有声其实是哑的）", () => {
    const { audioSupported } = require("../src/config/tokens");
    // ★ 1.x **收下这个参数却静默忽略**（2026-08-15 实测）—— 传过去两边都会以为
    //   "这一发有声"，用户只会觉得自己手机静音了。所以不支持的档只许 false/缺省。
    expect(audioSupported("doubao-seedance-1-0-pro-250528")).toBe(false);
    expect(audioSupported("doubao-seedance-1-0-pro-fast-251015")).toBe(false);
    expect(audioSupported("doubao-seedance-2-0-mini-260615")).toBe(true);
    expect(audioSupported(SEEDANCE_2_5)).toBe(true);
    // 认不出的 model 一律按"不支持"退（往不传那一侧退是安全的）
    expect(audioSupported("doubao-seedance-9-9-999999")).toBe(false);
    expect(audioSupported(undefined)).toBe(false);
    // 用户可控字符串查表不许顺原型链拿到函数（同 imageTokensOf 那条）
    expect(audioSupported("constructor")).toBe(false);
  });

  test("带参考视频的出片不收样片模式（draft:true → 400；缺省 / false 照常）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send({ ...r2vBody(publishedTpl.refVideo.url), draft: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(res.body.message).toMatch(/样片/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const ok = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send({ ...r2vBody(publishedTpl.refVideo.url), draft: false });
    expect(ok.status).toBe(501);
  });

  test("不带 reference_video 的任务不受影响（别把正常出片一起拦了）", async () => {
    // 免费版用「草稿」（2.0 mini · 480p）：免费档里不会停用的那一档（极速 2026-11-24 停用，用它的话这条会在那一天变红）
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send({ model: "doubao-seedance-2-0-mini-260615", duration: 5, resolution: "480p", content: [{ type: "text", text: "t" }] });
    expect(res.status).toBe(501); // 没配 key 时到 501 = 门都过了、走到 forward
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("r2v 第二条分支：本账号刚传、尚未登记的素材（白模化那一发）", () => {
  // ★ 为什么要开这条分支：白模化（原视频 → 带编号白模）那一发的输入是「用户刚传的
  //   素材裁出来的那一段」，此时世上还没有任何模板，按 refVideo.url 反查必然落空。
  //   而**绝不能**为了过闸门先把用户原视频登记成一个"模板"（会污染模板库、撞唯一索引、
  //   让试炼闸对着中间物计数）。
  // ★★ 这一组盯死的是**计价锚点**：输入时长只取 URL 里 `du_` 那个数 ——
  //   服务端拼 URL 时写进去的，Cloudinary 照它投递，方舟收到的就是这么长的一段。
  //   拆掉/写松的后果全都零症状：整条原片（最长 600s）按 4s 的价白嫖。
  const { SEEDANCE_2_5, r2vTokens } = require("../src/config/tokens");
  const BranchTemplate = require("../src/models/BranchTemplate");
  const walletSvc = require("../src/services/tokenWallet.service");
  const { cloudinary } = require("../src/config/cloudinary");

  const CLOUD = "https://res.cloudinary.com/demo/video/upload";
  let resourceSpy;

  /** 服务端拼出来的那种地址（形状与 utils/templateVideoAsset.buildClipUrl 逐字对齐）。
   *  ★ 测试里**手写**这个形状而不是调 buildClipUrl：要钉的正是"拼与解是同一种形状"，
   *    两边都调同一个函数的话，形状一起改也不会红。 */
  function clipUrlOf(ownerId, ts, { so = 0, du = 8, x = 0, y = 0, w = 900, h = 512 } = {}) {
    return `${CLOUD}/so_${so},du_${du},c_crop,x_${x},y_${y},w_${w},h_${h}/ideahub/template-videos/${ownerId}-${ts}.mp4`;
  }

  function r2vBody(url) {
    return {
      model: SEEDANCE_2_5,
      content: [
        { type: "text", text: "把画面里的人物换成白色人偶" },
        { type: "video_url", role: "reference_video", video_url: { url } },
      ],
      omni_reference_task_type: "edit",
      duration: -1,
      ratio: "adaptive",
    };
  }

  const asPaid = () => ({ Authorization: `Bearer ${paidToken}` });

  beforeAll(async () => {
    // 同上：本组每条都要真扣一次 r2v 的钱（96 万起），先充够再测
    await walletSvc.credit(paidUserId, 50_000_000, "recharge", "测试预置额度");
  });

  beforeEach(() => {
    // 原片：1920×1080 / 60s（裁剪框与选段都落在里面）
    resourceSpy = jest.spyOn(cloudinary.api, "resource").mockImplementation(async (publicId) => ({
      public_id: publicId,
      secure_url: `${CLOUD}/${publicId}.mp4`,
      duration: 60,
      width: 1920,
      height: 1080,
      bytes: 30_000_000,
      version: 1712000000,
    }));
  });

  afterEach(() => {
    resourceSpy.mockRestore();
  });

  test("未登记但归属本账号 → 按 URL 里的 durSec 计价（不是纯任务价、不是客户端报的数）", async () => {
    const TokenLedger = require("../src/models/TokenLedger");
    const durSec = 8;
    const expected = r2vTokens(durSec, SEEDANCE_2_5); // (8+8)×21600×2.8
    expect(expected).toBe(967_680); // 公式钉死：改公式必须先改这一行

    const before = await walletSvc.getWallet(paidUserId);
    const url = clipUrlOf(paidUserId, 7001, { du: durSec });
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(r2vBody(url));
    expect(res.status).toBe(501); // 没配 key：闸门与扣费都过了才到 forward

    const after = await walletSvc.getWallet(paidUserId);
    // 扣的是 r2v 价（先扣 plan 再扣 addon），501 后 W2 按扣的那两桶原样退回（2026-10-07 起）—— 两桶各自复原
    //   （原来断言「退回 addon、构成移动」，只因为 plan 恰好是 0 才一直绿着）
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });

    // 流水必须带来源标记：不带的话月底对账分不出白模化那一发花的钱
    const spend = await TokenLedger.findOne({
      user: paidUserId,
      reason: "ark_spend",
      memo: new RegExp(`r2v src:ideahub/template-videos/${paidUserId}-7001`),
    }).lean();
    expect(spend).toBeTruthy();
    expect(spend.delta).toBe(-expected);
  });

  test("时长不同 → 扣的钱真的跟着 du_ 走（写死成常量这条会红）", async () => {
    const TokenLedger = require("../src/models/TokenLedger");
    for (const du of [5, 20]) {
      // ★ 每轮先清掉当天流水：2026-09-24 起有**每日 token 上限**（付费档 3M/日，
      //   config/tokens.DAILY_LIMITS），而 r2v 一发就是几十万 —— 连发两发会撞上限，
      //   于是第二发变成 429 而不是 501。这条测的是「单价跟着时长走」，不是日上限。
      await TokenLedger.deleteMany({ user: paidUserId });
      await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set(asPaid())
        .send(r2vBody(clipUrlOf(paidUserId, 7100 + du, { du })))
        .expect(501);
      const spend = await TokenLedger.findOne({
        user: paidUserId,
        reason: "ark_spend",
        memo: new RegExp(`r2v src:ideahub/template-videos/${paidUserId}-${7100 + du}`),
      }).lean();
      expect({ du, cost: spend.delta }).toEqual({ du, cost: -r2vTokens(du, SEEDANCE_2_5) });
    }
  });

  test("没有 du_ 的地址（整段原片）→ 400：输入时长没有可信来源，不许按纯任务价放行", async () => {
    const url = `${CLOUD}/v1712000000/ideahub/template-videos/${paidUserId}-7002.mp4`;
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(r2vBody(url));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("别人账号的素材 → 400（归属钉在 public_id 形状上）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(freeUserId, 7003)));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("du_ 越出**白模输入**窗口 [5,30] → 400 整句", async () => {
    // ★★ 这条分支上的素材**就是白模化的输入**，所以判的是 blockoutInputIssue（下限 5），
    //   不是参考视频窗口（下限 4）。2026-08-16 起 du=4 也要拒：方舟收得下 4 秒，
    //   但它的产出只有 3.7 秒 —— 建出来的模板短于方舟自己的 4 秒下限，谁都套用不了，
    //   而作者已经付过钱了。
    // ★★★ 这两道门（阶段一与这里）**必须是同一个函数**：差一秒的话，一个老客户端
    //   就能从 /api/ark 这条路把 4 秒的白模化发出去，绕开编辑页那道墙再造一个废模板。
    for (const du of [3, 4, 31]) {
      const res = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set(asPaid())
        .send(r2vBody(clipUrlOf(paidUserId, 7200 + du, { du })));
      expect({ du, status: res.status }).toEqual({ du, status: 400 });
      expect(typeof res.body.message).toBe("string"); // 整句可显示，不是错误码天书
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("裁后不满足像素硬门（407,696）→ 400，且不出网不扣费", async () => {
    // 640×636 = 407,040 < 门
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(paidUserId, 7004, { w: 640, h: 636 })));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/分辨率太低/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("裁剪框超出画面 / 选段超出片长 → 400（Cloudinary 会自己裁到边界，不报错）", async () => {
    // 原片 1920×1080：x+w = 1900+900 越界
    const over = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(paidUserId, 7005, { x: 1900 })));
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/裁剪框超出/);

    // 原片 60s：so_58 + du_8 越界
    const late = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(paidUserId, 7006, { so: 58 })));
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/超出了视频长度/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("Cloudinary 查无此资源（编造的 public_id）→ 400，不扣费", async () => {
    resourceSpy.mockRejectedValue({ error: { http_code: 404, message: "not found" } });
    const before = await walletSvc.getWallet(paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(paidUserId, 7007)));
    expect(res.status).toBe(400);
    const after = await walletSvc.getWallet(paidUserId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });
  });

  test("已登记素材加一段裁剪变换 → 400（否则 blocked/未发布 两道门禁一裁剪就绕过去了）", async () => {
    const tpl = await BranchTemplate.create({
      ownerId: paidUserId,
      authorName: "seed",
      title: "tpl-blocked-src",
      recipe: { styleHint: "", beats: ["b"], durationSec: 5, videoTier: "ultra", framePrompt: "" },
      refVideo: {
        url: `${CLOUD}/v1/ideahub/template-videos/${paidUserId}-7008.mp4`,
        durationSec: 10,
        width: 720,
        height: 1280,
        bytes: 5_000_000,
        cloudinaryPublicId: `ideahub/template-videos/${paidUserId}-7008`,
      },
      status: "blocked",
      provenAt: null,
    });
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(r2vBody(clipUrlOf(paidUserId, 7008)));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/已经登记过/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await BranchTemplate.deleteOne({ _id: tpl._id });
  });

  test("四参数的钉子对新分支同样生效（否则这条分支就是绕过计价假设的旁门）", async () => {
    const mutations = [
      ["reference 子任务", (b) => { b.omni_reference_task_type = "reference"; }],
      ["duration=30", (b) => { b.duration = 30; }],
      ["resolution=1080p", (b) => { b.resolution = "1080p"; }],
      ["ratio=16:9", (b) => { b.ratio = "16:9"; }],
    ];
    for (const [name, mutate] of mutations) {
      const body = r2vBody(clipUrlOf(paidUserId, 7009));
      mutate(body);
      const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(body);
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("免费用户走这条分支照样撞免费档门禁（不是绕开它的旁路）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send(r2vBody(clipUrlOf(freeUserId, 7010)));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("跨仓音频能力一致性（app 的档位表 vs 服务端的钉子）", () => {
  // 抄自 app/src/data/economy.ts 的 VIDEO_TIERS[].audio（为什么抄不 fs 读：与上面
  // 视频/出图两组逐字相同的理由 —— server 独立部署，会自己跳过的用例是静默失败）。
  // ★ 分界在**模型代际不在价钱**：2.x 真出声，1.x 收下参数却静默忽略（2026-08-15 实测）。
  const APP_AUDIO = {
    "doubao-seedance-1-0-pro-fast-251015": false,
    "doubao-seedance-1-0-pro-250528": false,
    "doubao-seedance-2-0-mini-260615": true,
    "doubao-seedance-2-5-260628": true,
  };

  test("两张表的 key 集合与数值完全相等", () => {
    const { VIDEO_AUDIO } = require("../src/config/tokens");
    expect(VIDEO_AUDIO).toEqual(APP_AUDIO);
  });

  test("开音频不改任何计价公式（实测零额外成本，加系数就是凭空多收）", () => {
    const { r2vTokens, segTokens, SEEDANCE_2_5 } = require("../src/config/tokens");
    // 公式里根本没有音频这个入参 —— 这条断言的意义是：哪天有人给它加一个，
    // 得先回来解释为什么账单里两发有声/无声的用量与单价是逐位相同的
    expect(r2vTokens.length).toBe(2); // (inputDurationSec, model)
    expect(segTokens.length).toBe(2); // (durationSec, model, resolution = "720p", ratio)：带缺省值的参数不算进 length
    expect(r2vTokens(10, SEEDANCE_2_5)).toBe(1_209_600);
  });
});

describe("跨仓 r2v 系数一致性（app 的报价 vs 服务端的结算）", () => {
  // 抄自 app/src/data/economy.ts 的 VIDEO_TIERS[ultra].r2vMult（为什么抄不 fs 读：
  // 与上面视频/出图两组逐字相同的理由 —— server 独立部署，会自己跳过的用例是静默失败）。
  // app 侧四档里只有 ultra 有 r2v 价；refVid 布尔是**开闸开关**（另一个 commit 才翻 true），
  // 价目先行、开关后动 —— 价目缺失时 app 既不报价也不开炼。
  // 2026-10-05 起高清（2.0-mini）也有 r2v 价：刊例 14 元/M ⇒ 14/15（app economy 的 HD_R2V_MULT）
  const APP_R2V_MULTS = { "doubao-seedance-2-5-260628": 2.8, "doubao-seedance-2-0-mini-260615": 14 / 15 };

  test("两张表的 key 集合与数值完全相等", () => {
    const { VIDEO_MULT_R2V } = require("../src/config/tokens");
    expect(VIDEO_MULT_R2V).toEqual(APP_R2V_MULTS);
  });

  test("r2v 单价确实比纯任务贵（输入时长计费：42<70 的直觉是反的）", () => {
    const { r2vTokens, segTokens, SEEDANCE_2_5 } = require("../src/config/tokens");
    // 同样出 10s：r2v 还要为 10s 的输入付钱 ⇒ (10+10)×2.8 > 10×4.7
    expect(r2vTokens(10, SEEDANCE_2_5)).toBeGreaterThan(segTokens(10, SEEDANCE_2_5));
  });
});

describe("跨仓 chat 定额一致性（app 的报价 vs 服务端的结算）", () => {
  // 抄自 app/src/data/economy.ts（为什么抄不 fs 读：与上面视频/出图两组逐字相同的理由 ——
  // server 独立部署，会自己跳过的用例是静默失败）。
  // ★ app 侧有**两个**常量代表"一次 chat 调用"，两个都必须等于这边的 CHAT_TURN_TOKENS：
  //   CHAT_TURN_TOKENS —— 闲聊、画布 agent、看片提卡（economy.mintQuote 按调用次数乘它）；
  //   CARD_META_TOKENS —— 素材炼卡每张卡那一次文案 chat（forgeCost 按卡数乘它）。
  // ★ 2026-09-10 之前这个价**一条钉子都没有**，而 app 的看图报价按"每帧 900"算了很久：
  //   8 帧的一次看图 app 报 7,200、这边收 400，两仓各自的测试全绿。
  const APP_CHAT_TOKENS = { CHAT_TURN_TOKENS: 400, CARD_META_TOKENS: 400 };

  test("app 里代表一次 chat 的常量都等于服务端定额", () => {
    const { CHAT_TURN_TOKENS } = require("../src/config/tokens");
    for (const [name, tokens] of Object.entries(APP_CHAT_TOKENS)) {
      expect({ name, tokens }).toEqual({ name, tokens: CHAT_TURN_TOKENS });
    }
  });

  test("看图按调用收、不按张数（app 的 mintQuote 只数调用次数，靠的就是这一条）", () => {
    const { priceOf, CHAT_TURN_TOKENS } = require("../src/config/tokens");
    const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } };
    // 形状 = app arkClient.chatVision 真发的请求体（system + 一条 text + N 张图）
    const visionBody = (n) => ({
      model: "doubao-seed-2-1-turbo-260628",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "text", text: "看图" }, ...Array(n).fill(image)] },
      ],
      max_tokens: 1200,
      thinking: { type: "disabled" },
    });
    // ★ 哪天 chat 改成按图数 / 用量计价，这条会红 —— 那时 app 的 economy.mintQuote 与
    //   blockoutTemplateCost 必须一起改（它们没有帧数参数是有意的），别只把这条断言改绿。
    for (const n of [0, 1, 8]) {
      expect({ images: n, cost: priceOf("chat", visionBody(n)) }).toEqual({ images: n, cost: CHAT_TURN_TOKENS });
    }
  });
});

describe("r2v 第三条分支：用户素材参考视频（自定义 = 多图 + 参考视频，2026-08-28）", () => {
  // ★ 与前两条分支的差别：reference 子任务（不是 edit）、输出时长用户选（这个模型的窗口内，2.5 是 4~30）、
  //   计价 = (登记输入 + 输出)×720p 锚×2.8（tokens.materialRefTokens）。
  //   参数钉子是素材专属那一套（omni 必须缺省、duration 必须是窗口内的整数）。
  const MaterialRefVideo = require("../src/models/MaterialRefVideo");
  let matUrl;

  /** 素材参考的任务体 —— 形状 = App 自定义车道的真实请求 */
  function matBody(url, extra = {}) {
    return {
      model: "doubao-seedance-2-5-260628",
      content: [
        { type: "text", text: "图片1是这段视频的第一帧画面，图片2是最后一帧画面。" },
        { type: "video_url", role: "reference_video", video_url: { url } },
        { type: "image_url", role: "reference_image", image_url: { url: "https://res.example/first.jpg" } },
        { type: "image_url", role: "reference_image", image_url: { url: "https://res.example/last.jpg" } },
      ],
      duration: 5,
      resolution: "720p",
      ratio: "9:16",
      ...extra,
    };
  }

  beforeAll(async () => {
    matUrl = "https://res.cloudinary.com/test/video/upload/v1/ideahub/template-videos/" + paidUserId + "-777.mp4";
    await MaterialRefVideo.create({
      userId: paidUserId,
      publicId: `ideahub/template-videos/${paidUserId}-777`,
      url: matUrl,
      durationSec: 10,
      bytes: 1_000_000,
      width: 704,
      height: 1248,
    });
  });

  test("登记素材 + 合规参数 → 过闸并按 (10+5)×21600×2.8 扣费（501 = 无 key 走到 forward）", async () => {
    const wallet = require("../src/services/tokenWallet.service");
    const before = await wallet.getWallet(paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(matBody(matUrl));
    // 没配 ARK key：闸门全过后 forward 才失败（与既有试炼用例同判法）——
    // 且未受理的钱要原路退回（W2）
    expect(res.status).toBe(501);
    const after = await wallet.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
    // 计价公式独立断言（与 app economy.materialRefCost 跨仓逐字相等）
    const { materialRefTokens } = require("../src/config/tokens");
    expect(materialRefTokens(10, 5, "doubao-seedance-2-5-260628")).toBe(Math.round((10 + 5) * 21_600 * 2.8));
    // 2026-10-03 起输出窗口跟模型走（2.5 到 30 秒）：30 秒的输出按 30 秒收，不再夹到 10
    expect(materialRefTokens(10, 30, "doubao-seedance-2-5-260628")).toBe(Math.round((10 + 30) * 21_600 * 2.8));
  });

  test("高清（2.0-mini）素材参考 → 过闸并按 (10+5)×21600×14/15 扣（2026-10-05 开）", async () => {
    const wallet = require("../src/services/tokenWallet.service");
    const before = await wallet.getWallet(paidUserId);
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(matBody(matUrl, { model: "doubao-seedance-2-0-mini-260615", omni_reference_task_type: "reference" }));
    expect(res.body.code).not.toBe("R2V_NOT_ALLOWED");
    expect(res.status).toBe(501);
    const after = await wallet.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
    const { materialRefTokens } = require("../src/config/tokens");
    expect(materialRefTokens(10, 5, "doubao-seedance-2-0-mini-260615")).toBe(302_400); // (10 + 5) × 21600 × 14/15
  });

  test("高清（2.0-mini）素材参考输出 16 秒（超出 mini 的 4~15）→ 400 不出网", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(matBody(matUrl, { model: "doubao-seedance-2-0-mini-260615", duration: 16 }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("输出 30 秒（2.5 窗口的上界）过素材钉子（2026-10-03 前这里会被 3~10 拒）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(matBody(matUrl, { duration: 30 }));
    expect(res.body.code).not.toBe("R2V_NOT_ALLOWED");
    expect([402, 501]).toContain(res.status);
  });

  test("别人的素材 → 400（素材私有，URL 泄了也蹭不了）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send(matBody(matUrl));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(res.body.message).toMatch(/别人/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["带 omni_reference_task_type（那是白模的参数）", { omni_reference_task_type: "edit" }],
    ["duration=-1（reference 会推到 30s 上界）", { duration: -1 }],
    ["duration=31（超出 2.5 的 4~30）", { duration: 31 }],
    ["duration=3（低于 2.5 的下限 4）", { duration: 3 }],
    ["duration=4.5（不是整数）", { duration: 4.5 }],
    ["resolution=1080p", { resolution: "1080p" }],
    ["ratio=1:1", { ratio: "1:1" }],
  ])("素材参考参数越出计价假设（%s）→ 400 不出网", async (_n, extra) => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(matBody(matUrl, extra));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("r2v 第四条分支：本人自己出的成片（返修 / 片段重拍 / 延长，2026-10-05）", () => {
  // ★ 为什么开这条分支：返修（App「✎ 返修这一段」，2026-09-06）发的参考视频就是本段自己的成片
  //   （出片即转存的 ideahub/branch-videos/<userId>-<毫秒>-seg），此前三条分支一条都不认它 ——
  //   正式包里的返修一直被整句 400（不扣钱），只在 dev 直连方舟时跑得通。延长（extend）同样要靠它。
  // ★★ 这一组盯死的是两件零症状的事：① 计价的输入时长只认服务端向 Cloudinary 查到的数（客户端报的不信）；
  //   ② edit 与 extend 各走各的公式（编辑 = 输入 × 2，延长 = 输入 + 输出）—— 混用的话延长 25 秒按 5 秒的价收。
  const { SEEDANCE_2_5, r2vTokens, materialRefTokens } = require("../src/config/tokens");
  const walletSvc = require("../src/services/tokenWallet.service");
  const TokenLedger = require("../src/models/TokenLedger");
  const SegmentRefVideo = require("../src/models/SegmentRefVideo");
  const { cloudinary } = require("../src/config/cloudinary");

  const CLOUD = "https://res.cloudinary.com/demo/video/upload";
  let resourceSpy;
  /** 出片即转存的成片地址（形状手写、不调 videoCompose：要钉的正是「转存写出的形状」与「闸门认的形状」是同一种） */
  const segUrl = (uid, ts) => `${CLOUD}/v1789000000/ideahub/branch-videos/${uid}-${ts}-seg.mp4`;
  const segId = (uid, ts) => `ideahub/branch-videos/${uid}-${ts}-seg`;
  const asPaid = () => ({ Authorization: `Bearer ${paidToken}` });

  function ownBody(url, extra = {}) {
    return {
      model: SEEDANCE_2_5,
      content: [
        { type: "text", text: "编辑视频1：把背景换成雨夜" },
        { type: "video_url", role: "reference_video", video_url: { url } },
      ],
      omni_reference_task_type: "edit",
      duration: -1,
      ratio: "adaptive",
      ...extra,
    };
  }
  const extendBody = (url, extra = {}) =>
    ownBody(url, { omni_reference_task_type: "extend", duration: 8, ...extra, content: [{ type: "text", text: "向后延长视频1：她推门走进雨里" }, { type: "video_url", role: "reference_video", video_url: { url } }] });

  /** 成片的「云端真相」：5.04 秒、704×1248（竖屏 720p 的实际尺寸） */
  let cloudMeta = { duration: 5.041667, width: 704, height: 1248 };

  beforeAll(async () => {
    await walletSvc.credit(paidUserId, 50_000_000, "recharge", "测试预置额度");
  });

  beforeEach(async () => {
    // 每条先清当天流水（付费档有每日 token 上限，r2v 一发就是几十万 —— 同第二条分支那组的 ★）
    await TokenLedger.deleteMany({ user: paidUserId });
    await SegmentRefVideo.deleteMany({});
    cloudMeta = { duration: 5.041667, width: 704, height: 1248 };
    resourceSpy = jest.spyOn(cloudinary.api, "resource").mockImplementation(async (publicId) => ({
      public_id: publicId,
      secure_url: `${CLOUD}/${publicId}.mp4`,
      ...cloudMeta,
      bytes: 6_000_000,
      version: 1789000000,
    }));
  });

  afterEach(() => {
    resourceSpy.mockRestore();
  });

  test("返修（edit）→ 按 r2vTokens（输入 × 2）扣；输入时长取云端查到的数；流水标 edit own", async () => {
    const before = await walletSvc.getWallet(paidUserId);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9001)));
    expect(res.status).toBe(501); // 没配 key：闸门与扣费都过了才到 forward
    const expected = r2vTokens(5.041667, SEEDANCE_2_5);
    expect(expected).toBe(604_800); // 5 × 2 × 21600 × 2.8：改公式必须先改这一行
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend", memo: new RegExp(`r2v edit own:${segId(paidUserId, 9001)}`) }).lean();
    expect(spend).toBeTruthy();
    expect(spend.delta).toBe(-expected);
    const after = await walletSvc.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon); // 501 后原路退回
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("高清（2.0-mini）返修 → 按 r2vTokens(…, mini) 扣（输入 × 2 × 14/15，2026-10-05 开）", async () => {
    const MINI = "doubao-seedance-2-0-mini-260615";
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9011), { model: MINI }));
    expect(res.status).toBe(501);
    const expected = r2vTokens(5.041667, MINI);
    expect(expected).toBe(201_600); // 5 × 2 × 21600 × 14/15
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend", memo: new RegExp(`r2v edit own:${segId(paidUserId, 9011)}`) }).lean();
    expect(spend.delta).toBe(-expected);
  });

  test("延长（extend）→ 按 (输入 + 输出) 扣，不是 edit 的输入 × 2；流水标 extend own", async () => {
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(extendBody(segUrl(paidUserId, 9002), { duration: 8 })).expect(501);
    const expected = materialRefTokens(5.041667, 8, SEEDANCE_2_5);
    expect(expected).toBe(786_240); // (5 + 8) × 21600 × 2.8
    expect(expected).not.toBe(r2vTokens(5.041667, SEEDANCE_2_5));
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend", memo: new RegExp(`r2v extend own:${segId(paidUserId, 9002)}`) }).lean();
    expect(spend.delta).toBe(-expected);
  });

  test("同一段第二次用 → 读缓存，不再问 Cloudinary Admin API（全局配额）", async () => {
    const url = segUrl(paidUserId, 9003);
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(url)).expect(501);
    await TokenLedger.deleteMany({ user: paidUserId });
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(extendBody(url)).expect(501);
    expect(resourceSpy).toHaveBeenCalledTimes(1);
    const cached = await SegmentRefVideo.findOne({ publicId: segId(paidUserId, 9003) }).lean();
    expect(cached.durationSec).toBeCloseTo(5.041667, 5);
  });

  test("别人的成片 → 400（归属钉在文件名的 user id 上），不出网不扣费", async () => {
    const before = await walletSvc.getWallet(paidUserId);
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(freeUserId, 9004)));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(resourceSpy).not.toHaveBeenCalled();
    const after = await walletSvc.getWallet(paidUserId);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  test("云端查不到这段（404）→ 400 说清楚；别的读失败 → 502；都不扣钱", async () => {
    resourceSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("not found"), { error: { http_code: 404, message: "Resource not found" } });
    });
    const r404 = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9005)));
    expect(r404.status).toBe(400);
    expect(r404.body.message).toMatch(/找不到这一段成片/);
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    resourceSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error("boom"), { error: { http_code: 500, message: "boom" } });
    });
    const r502 = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9006)));
    spy.mockRestore();
    expect(r502.status).toBe(502);
    expect(await TokenLedger.countDocuments({ user: paidUserId, reason: "ark_spend" })).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("成片越出方舟参考视频窗口（3.5 秒 / 31 秒）→ 400，不出网", async () => {
    for (const duration of [3.5, 31]) {
      await SegmentRefVideo.deleteMany({});
      cloudMeta = { duration, width: 704, height: 1248 };
      const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9100 + Math.round(duration))));
      expect({ duration, status: res.status }).toEqual({ duration, status: 400 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["不带任务类型", { omni_reference_task_type: undefined }],
    ["reference 子任务（这一期不开）", { omni_reference_task_type: "reference", duration: 5 }],
    ["edit 却指定时长 5（输出跟随输入，只收 -1）", { duration: 5 }],
    ["edit 1080p", { resolution: "1080p" }],
    ["edit 比例 16:9", { ratio: "16:9" }],
  ])("返修参数越出计价假设（%s）→ 400 不出网", async (_n, extra) => {
    const body = ownBody(segUrl(paidUserId, 9200), extra);
    if (extra.omni_reference_task_type === undefined) delete body.omni_reference_task_type;
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ["duration=-1（智能时长会推到上界）", { duration: -1 }],
    ["duration=31（超出 2.5 的 4~30）", { duration: 31 }],
    ["duration=3（低于下限 4）", { duration: 3 }],
    ["duration=4.5（不是整数）", { duration: 4.5 }],
    ["resolution=1080p", { resolution: "1080p" }],
    ["ratio=9:16（延长只收 adaptive）", { ratio: "9:16" }],
  ])("延长参数越出计价假设（%s）→ 400 不出网", async (_n, extra) => {
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(extendBody(segUrl(paidUserId, 9300), extra));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("R2V_NOT_ALLOWED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 2026-10-05 起高清（2.0-mini）在 r2v 价目表里（付费探测三发全成，主人「合」）：服务端只管价钱 ——
  //   高清的延长接缝会跳，开不开由 app 的 VideoTier.extendOk 挡；真有请求来，照 (输入 + 输出) × 14/15 结算，不会少收
  test("高清档（2.0 mini）延长 → 按 (输入 + 输出) × 14/15 结算（服务端不管画面，只管价钱）", async () => {
    const MINI = "doubao-seedance-2-0-mini-260615";
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(asPaid())
      .send(extendBody(segUrl(paidUserId, 9400), { model: MINI, duration: 5 }));
    expect(res.status).toBe(501);
    const expected = materialRefTokens(5.041667, 5, MINI);
    expect(expected).toBe(201_600); // (5 + 5) × 21600 × 14/15
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend", memo: new RegExp(`r2v extend own:${segId(paidUserId, 9400)}`) }).lean();
    expect(spend.delta).toBe(-expected);
  });

  test("返修开着出声（2.5 支持音频）→ 放行；计价不变（开音频零额外成本）", async () => {
    await request(app).post("/api/ark/contents/generations/tasks").set(asPaid()).send(ownBody(segUrl(paidUserId, 9500), { generate_audio: true })).expect(501);
    const spend = await TokenLedger.findOne({ user: paidUserId, reason: "ark_spend", memo: /r2v edit own:/ }).lean();
    expect(spend.delta).toBe(-r2vTokens(5.041667, SEEDANCE_2_5));
  });
});
