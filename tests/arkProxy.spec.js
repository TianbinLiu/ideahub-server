// tests/arkProxy.spec.js
// 覆盖：/api/ark 火山方舟代理的四道闸门。
//
// ★ 为什么这条路由值得一份回归测试：它每一次转发都**真花钱**
//   （Seedance 一段约 1.9 元、Seedream 一张约 0.6 元），而这四道闸门的共同点是
//   「拆掉也不会有任何报错」—— 功能照常，只有账单和攻击者会发现：
//     ① 少了 requireAuth        → 任何人知道 URL 就能用我们的 key
//     ② 白名单外的上游路径可达  → 变成通用反向代理，能调方舟任意模型
//     ③ model 不校验            → 能点名 seedance-2.5（70 元/M，是标准档的 4.7 倍）
//     ④ asset 的域名/SSRF 不校验 → 变成公开下载代理 + 内网探测器
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
let token;
let fetchSpy;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.ARK_API_KEY; // 明确：本套用例一律不带 key

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");

  const name = `ark_${Date.now().toString(36)}`;
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
    "doubao-seedance-2-5-260601", // 70 元/M，标准档的 4.7 倍
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

describe("健康端点", () => {
  test("不需要登录，且只说配没配、不泄露 key", async () => {
    const res = await request(app).get("/api/ark/health").expect(200);
    expect(res.body).toEqual({ ok: true, ark: false });
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|Bearer/i);
  });
});
