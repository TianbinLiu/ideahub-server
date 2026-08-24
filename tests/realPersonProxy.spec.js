// tests/realPersonProxy.spec.js
// 覆盖：/api/minimax 与 /api/runway —— 真人视频档代理**脚手架**的几道门。
//
// ★ 为什么脚手架也值得测：这两条路今天全是 501（key 还没申请），但闸门的共同点
//   与 arkProxy.spec.js 一样是「拆掉也不会有任何报错」：
//     ① 少了 requireAuth        → 配上 key 那天起，任何人知道 URL 就能烧我们的账单
//     ② 字段白名单松了          → callback_url / contentModeration 之类直通上游；
//        Runway 的 contentModeration 是**合规钉子**（名人不在产品授权范围里），
//        它被透传的那一刻没有任何症状，只有出事时的责任
//     ③ 501 的口径歪了          → App 把真人档亮出来，用户点了才发现全失败
//   照 arkProxy.spec.js 的套路：fetch 间谍把「确实没出网」也断言掉。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let token;
let fetchSpy;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  // 明确：本套用例默认不带 key（开发机的 .env 可能配了，测试不吃环境的运气）
  delete process.env.MINIMAX_API_KEY;
  delete process.env.RUNWAY_API_KEY;

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");

  const name = `real_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  token = res.body.token;
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  // 出网间谍：任何一次 fetch 都记下来。断言"没出网"靠它，不靠推理。
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
    throw new Error("测试里不应该有任何出网请求");
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

const BUSINESS_ENDPOINTS = [
  ["post", "/api/minimax/video"],
  ["get", "/api/minimax/video/12345"],
  ["post", "/api/runway/video"],
  ["get", "/api/runway/tasks/0f1e2d3c-0000-4000-8000-000000000000"],
];

describe("鉴权闸门：业务端点一个都不许裸奔", () => {
  test.each(BUSINESS_ENDPOINTS)("%s %s 未登录 → 401，且不出网", async (method, path) => {
    const res = await request(app)[method](path).send({ model: "x" });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("未配 key：业务端点全部 501（App 据此把真人档置灰）", () => {
  test.each(BUSINESS_ENDPOINTS)("%s %s → 501 { message }，且不出网", async (method, path) => {
    const res = await request(app)[method](path).set(auth()).send({ model: "x" });
    expect(res.status).toBe(501);
    expect(typeof res.body.message).toBe("string");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("health 不需要登录、只说配没配、不真打上游（与 /api/ark/health 同口径）", async () => {
    const mm = await request(app).get("/api/minimax/health").expect(200);
    expect(mm.body).toEqual({ ok: true, minimax: false });
    const rw = await request(app).get("/api/runway/health").expect(200);
    expect(rw.body).toEqual({ ok: true, runway: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("白名单转发（配假 key + 假上游，看真正发出去的是什么）", () => {
  test("minimax：白名单外的字段被丢弃（callback_url 直通上游 = 拿我们的 key 当骚扰炮）", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ task_id: "1", base_resp: { status_code: 0, status_msg: "success" } }),
      }));
      const res = await request(app).post("/api/minimax/video").set(auth()).send({
        // ★ 2026-08-24 起 model 必须是计价表在册的 2.3（Hailuo-02 没有价 → 400 model not allowed）
        model: "MiniMax-Hailuo-2.3",
        prompt: "p",
        duration: 6,
        resolution: "768P",
        callback_url: "https://evil.example.com/hook",
        prompt_optimizer: true,
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.minimaxi.com/v1/video_generation");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      // toEqual 是双向比较：白名单内少转发一个、白名单外多漏一个，都会红
      expect(JSON.parse(init.body)).toEqual({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 6, resolution: "768P" });
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test("runway：contentModeration 被服务端钉死丢弃（合规：名人不在授权范围），版本头在", async () => {
    process.env.RUNWAY_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({ status: 200, text: async () => JSON.stringify({ id: "t1" }) }));
      const res = await request(app).post("/api/runway/video").set(auth()).send({
        model: "gen4_turbo",
        promptImage: "data:image/png;base64,QQ==",
        promptText: "t",
        ratio: "720:1280",
        duration: 5,
        // ★ 客户端试图解锁公众人物闸：必须被整个丢弃，供应商默认（严）档就是产品要的闸
        contentModeration: { publicFigureThreshold: "low" },
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
      expect(init.headers["X-Runway-Version"]).toBe("2024-11-06");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      const sent = JSON.parse(init.body);
      expect(sent.contentModeration).toBeUndefined();
      expect(sent).toEqual({
        model: "gen4_turbo",
        promptImage: "data:image/png;base64,QQ==",
        promptText: "t",
        ratio: "720:1280",
        duration: 5,
      });
    } finally {
      delete process.env.RUNWAY_API_KEY;
    }
  });

  test("任务 id 只收安全字符集（不许把路径拼进上游 URL）", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    process.env.RUNWAY_API_KEY = "test-key";
    try {
      // 400（TASK_ID_RE 挡下）或 404（路由都匹配不上）都算挡住，唯独不能穿透到上游
      const mm = await request(app).get("/api/minimax/video/..%2F..%2Ffiles").set(auth());
      expect([400, 404]).toContain(mm.status);
      const rw = await request(app).get("/api/runway/tasks/..%2F..%2Forganization").set(auth());
      expect([400, 404]).toContain(rw.status);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.MINIMAX_API_KEY;
      delete process.env.RUNWAY_API_KEY;
    }
  });
});


// ── 真人档计费（报价=实扣，chargedArkCall 序列复用）─────────────────────────
describe("真人档计费", () => {
  // ★ 本组用**专属账号**：白名单转发那组现在也走真扣费（假 key + 假上游照扣照退），
  //   共用账号的话余额随用例顺序漂移，断言全变成"看排期的运气"
  let billToken;
  beforeAll(async () => {
    const name = `bill_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const r = await request(app)
      .post("/api/auth/register")
      .send({ username: name, email: `${name}@test.local`, password: "secret123" })
      .expect(201);
    billToken = r.body.token;
  });
  const bauth = () => ({ Authorization: `Bearer ${billToken}` });
  const walletOf = async () => {
    const r = await request(app).get("/api/me/wallet").set(bauth()).expect(200);
    return r.body.wallet; // 形状是 {ok, wallet:{plan,addon,…}, plans}
  };
  const okUpstream = () =>
    fetchSpy.mockImplementation(async () => ({
      status: 200,
      text: async () => JSON.stringify({ task_id: "42", base_resp: { status_code: 0, status_msg: "success" } }),
    }));

  test("价目钉子：与 app 的 economy.ts real 档 flatCost 逐条相等", () => {
    // ★★ 跨仓钉子：app/src/data/economy.ts VIDEO_TIERS id:"real" 的 flatCost = {6:135_000, 10:270_000}。
    //   改价必须两仓同一个提交（汇率变动也算改价）。这条红了 = 报价与实扣分家了。
    const { MINIMAX_FLAT_COST } = require("../src/config/tokens");
    expect(MINIMAX_FLAT_COST).toEqual({ 6: 135000, 10: 270000 });
  });

  test("表外时长整发 400，不出网不扣钱", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      const before = await walletOf();
      const res = await request(app)
        .post("/api/minimax/video")
        .set(bauth())
        .send({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 7 });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
      const after = await walletOf();
      expect(after.plan + after.addon).toBe(before.plan + before.addon);
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test("表外分辨率整发 400（不悄悄改写参数——那是偷换商品）", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      const res = await request(app)
        .post("/api/minimax/video")
        .set(bauth())
        .send({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 6, resolution: "1080P" });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test("受理即扣 135k（6s），响应头带扣后余额", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      okUpstream();
      const before = await walletOf();
      const res = await request(app)
        .post("/api/minimax/video")
        .set(bauth())
        .send({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 6, resolution: "768P" });
      expect(res.status).toBe(200);
      const after = await walletOf();
      expect(before.plan + before.addon - (after.plan + after.addon)).toBe(135000);
      expect(Number(res.headers["x-wallet-plan"]) + Number(res.headers["x-wallet-addon"])).toBe(after.plan + after.addon);
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test("上游业务拒绝（200 + status_code≠0）→ 全额退回：HTTP 2xx 不等于受理", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => ({
        status: 200,
        text: async () => JSON.stringify({ task_id: "", base_resp: { status_code: 2013, status_msg: "invalid params" } }),
      }));
      const before = await walletOf();
      const res = await request(app)
        .post("/api/minimax/video")
        .set(bauth())
        // 6s 而不是 10s：本套用例共用一个账号，上一发已实扣 135k，
        // 270k 会先在余额门禁上 402，测不到"受理判据"这一步
        .send({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 6, resolution: "768P" });
      expect(res.status).toBe(200); // 原样透传，业务码在 base_resp 里
      const after = await walletOf();
      expect(after.plan + after.addon).toBe(before.plan + before.addon);
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });

  test("上游 5xx / 断连（forward 折成 504）→ 全额退回", async () => {
    process.env.MINIMAX_API_KEY = "test-key";
    try {
      fetchSpy.mockImplementation(async () => {
        throw new Error("boom");
      });
      const before = await walletOf();
      const res = await request(app)
        .post("/api/minimax/video")
        .set(bauth())
        .send({ model: "MiniMax-Hailuo-2.3", prompt: "p", duration: 6, resolution: "768P" });
      expect(res.status).toBe(504);
      const after = await walletOf();
      expect(after.plan + after.addon).toBe(before.plan + before.addon);
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });
});
