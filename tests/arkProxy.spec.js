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
//     ⑤ 套餐门禁没了            → 免费用户能调 seedance-2.5（70 元/M，标准档的 4.7 倍，
//                                 一段 10 秒 ≈ 100 万 token，是他整月额度的三倍多）
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

describe("套餐门禁：seedance-2.5 只对付费套餐开放", () => {
  const { SEEDANCE_2_5 } = require("../src/config/tokens");
  const taskBody = { model: SEEDANCE_2_5, duration: 5, content: [] };

  test("免费版调 2.5 → 403 PLAN_REQUIRED，理由可读，且不出网", async () => {
    const res = await request(app).post("/api/ark/contents/generations/tasks").set(auth()).send(taskBody);

    expect(res.status).toBe(403); // 不是 402：充值解决不了，得换套餐
    expect(res.body.code).toBe("PLAN_REQUIRED");
    // ★ message 必须是一句能直接贴到界面上的话。客户端只会把它原样显示
    //   （全 app 没有地方监听 emitApiError，也没有第二份文案表）。
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toMatch(/付费套餐/);
    expect(res.body.message).toMatch(/免费版/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("被门禁拒掉时一分钱都不许扣（门禁排在扣费之前）", async () => {
    // ★ 顺序写反的话这条会红：免费用户 30 万额度扣不动 50 万，会先变成 402，
    //   真正的原因被"余额不足"盖住，用户只会一直去充值。
    const walletSvc = require("../src/services/tokenWallet.service");
    const before = await walletSvc.getWallet(freeUserId);
    await request(app).post("/api/ark/contents/generations/tasks").set(auth()).send(taskBody).expect(403);
    const after = await walletSvc.getWallet(freeUserId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });
  });

  test("付费套餐调 2.5 过得了门禁（没配 key 时到 501，说明已经走到 forward）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(taskBody);
    expect(res.status).toBe(501); // ark not configured —— 门禁与扣费都过了
    expect(fetchSpy).not.toHaveBeenCalled(); // 501 在发请求之前返回
  });

  test("免费版调其它在册档位不受影响（门禁只针对 paidOnly 那一档）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send({ model: "doubao-seedance-1-0-pro-fast-251015", duration: 5, content: [] });
    expect(res.status).toBe(501);
  });
});

describe("跨仓档位系数一致性（app 的报价 vs 服务端的结算）", () => {
  // ★ 为什么把 app 那份**抄**在这里，而不是 fs 读 app 仓的 economy.ts：
  //   server 是独立部署的（ECS 上只有这一个仓，CI 里也没有 app 的代码）。
  //   读文件的写法在这台开发机上能过、在 CI 上只能"文件不在就跳过"——
  //   而一条会自己跳过的用例，正是本项目最怕的那种静默失败：以后有人改了 app
  //   的 mult 却没改这边，测试照样全绿，用户看到的是"报价 216k、扣了 1,015,200"。
  //   抄一份的代价是改价时要动两个仓，但那正是我们想要的提醒（payOrder.spec.js
  //   末尾的价目表用的是同一招）。
  const APP_VIDEO_TIERS = [
    { id: "fast", model: "doubao-seedance-1-0-pro-fast-251015", mult: 0.3 },
    { id: "std", model: "doubao-seedance-1-0-pro-250528", mult: 1 },
    { id: "hd", model: "doubao-seedance-2-0-mini-260615", mult: 1.6 },
    { id: "ultra", model: "doubao-seedance-2-5-260628", mult: 4.7 },
  ];

  test("两张表的 key 集合与数值完全相等", () => {
    const { VIDEO_MULT } = require("../src/config/tokens");
    const fromApp = Object.fromEntries(APP_VIDEO_TIERS.map((t) => [t.model, t.mult]));
    // toEqual 对对象是**双向**比较：这边多一个模型、少一个模型、或者数值差一点，都会红
    expect(VIDEO_MULT).toEqual(fromApp);
  });

  test("在册模型与档位表一一对应（新增档位不许漏掉 ALLOWED_MODELS）", async () => {
    // 白名单是私有常量，所以从行为上验：每个档位的 model 都得能过"在册"这一关。
    // 漏掉一行的症状是 400 model not allowed —— 用户那边表现为"这一档永远失败"。
    for (const t of APP_VIDEO_TIERS) {
      const res = await request(app)
        .post("/api/ark/contents/generations/tasks")
        .set({ Authorization: `Bearer ${paidToken}` })
        .send({ model: t.model, duration: 5, content: [] });
      expect({ id: t.id, status: res.status }).toEqual({ id: t.id, status: 501 });
    }
  });

  test("2.5 的一段片确实超过免费版整月额度（门禁的前提，也是给用户的说法）", () => {
    const { segTokens, planOf } = require("../src/config/tokens");
    // 取**最短**的 3 秒：连最便宜的一段都超月额，说明"免费版怎么都用不了这一档"
    // 是事实陈述，不是营销话术。
    expect(segTokens(3, "doubao-seedance-2-5-260628")).toBeGreaterThan(planOf("free").monthlyTokens);
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
    expect(res.body).toEqual({ ok: true, ark: false });
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

  test("model 不在 r2v 价目表（2.0-mini）→ 400，绝不静默按纯任务价结算", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set({ Authorization: `Bearer ${paidToken}` })
      .send(r2vBody(publishedTpl.refVideo.url, "doubao-seedance-2-0-mini-260615"));
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
    // 方舟在 r2v edit 路真收 generate_audio（2026-08-15 探针实测），而 r2vTokens 没有音频项
    ["generate_audio=true（无声价买有声产出）", (b) => { b.generate_audio = true; }],
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

  test("免费用户走 r2v 照样撞 2.5 的套餐门禁（r2v 不是绕开 paidOnly 的旁路）", async () => {
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
    // 扣的是 r2v 价（先扣 plan），退回进 addon —— 总额不变、构成移动，两头都对得上
    expect(after.plan).toBe(before.plan - Math.min(before.plan, expected));
    expect(after.plan + after.addon).toBe(before.plan + before.addon);

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
        .send(r2vBody(pendingTpl.refVideo.url));
      expect(createRes.status).toBe(200);

      // 受理即落追踪：{taskId, templateId, userId} —— 试炼的证据由服务端自己记
      const trial = await BranchTemplateTrial.findOne({ taskId: "cgt-trial-0001" }).lean();
      expect(String(trial.templateId)).toBe(String(pendingTpl._id));
      expect(String(trial.userId)).toBe(String(paidUserId));

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
      expect(await BranchTemplateTrial.findOne({ taskId: "cgt-trial-0001" }).lean()).toBeNull();
    } finally {
      delete process.env.ARK_API_KEY;
    }
  });

  test("不带 reference_video 的任务不受影响（别把正常出片一起拦了）", async () => {
    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(auth())
      .send({ model: "doubao-seedance-1-0-pro-fast-251015", duration: 5, content: [{ type: "text", text: "t" }] });
    expect(res.status).toBe(501); // 没配 key 时到 501 = 门都过了、走到 forward
  });
});

describe("跨仓 r2v 系数一致性（app 的报价 vs 服务端的结算）", () => {
  // 抄自 app/src/data/economy.ts 的 VIDEO_TIERS[ultra].r2vMult（为什么抄不 fs 读：
  // 与上面视频/出图两组逐字相同的理由 —— server 独立部署，会自己跳过的用例是静默失败）。
  // app 侧四档里只有 ultra 有 r2v 价；refVid 布尔是**开闸开关**（另一个 commit 才翻 true），
  // 价目先行、开关后动 —— 价目缺失时 app 既不报价也不开炼。
  const APP_R2V_MULTS = { "doubao-seedance-2-5-260628": 2.8 };

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
