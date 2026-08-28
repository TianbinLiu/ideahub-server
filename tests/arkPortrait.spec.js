// tests/arkPortrait.spec.js
// 覆盖：真人肖像授权两个端点（/api/ark/portrait/*）+ V4 签名的确定性。
//
// ★ 这套用例**不会真的打火山 OpenAPI**：
//   · 没配 VOLC_AK/VOLC_SK 时端点必须 503（而不是 500 或裸奔）——这是 app 退回
//     "控制台手工"那条老路的依据；
//   · 配了假 AK/SK 时用 fetch 间谍拦住出网，断言"确实发了签名请求、且没真出网"，
//     并验签名头的形状（V4 的四个必需头 + Authorization 的 Credential/SignedHeaders）。
// ★ 还有一条纯单元：同样的入参 + 固定时间，签名必须**可复现**（换一个字符就变）——
//   签名一旦不确定，真机上就是"时灵时不灵"，最难查。
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

let mongod;
let app;

async function registerUser() {
  const name = `pt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return res.body.token;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.VOLC_AK;
  delete process.env.VOLC_SK;
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe("真人肖像授权端点 · /api/ark/portrait", () => {
  test("未登录一律 401（这些调用花的是我们企业账号的资源）", async () => {
    await request(app).post("/api/ark/portrait/invite").send({}).expect(401);
    await request(app).get("/api/ark/portrait/groups").expect(401);
    await request(app).get("/api/ark/portrait/assets").expect(401);
  });

  test("没配 AK/SK 时返回 503 + PORTRAIT_NOT_CONFIGURED（而不是 500）", async () => {
    const token = await registerUser();
    const inv = await request(app)
      .post("/api/ark/portrait/invite")
      .set("Authorization", `Bearer ${token}`)
      .send({ days: 30 })
      .expect(503);
    expect(inv.body.code).toBe("PORTRAIT_NOT_CONFIGURED");

    const grp = await request(app)
      .get("/api/ark/portrait/groups")
      .set("Authorization", `Bearer ${token}`)
      .expect(503);
    expect(grp.body.code).toBe("PORTRAIT_NOT_CONFIGURED");

    const ast = await request(app)
      .get("/api/ark/portrait/assets")
      .set("Authorization", `Bearer ${token}`)
      .expect(503);
    expect(ast.body.code).toBe("PORTRAIT_NOT_CONFIGURED");
  });

  test("days 超范围被 zod 挡下（366 天上限）", async () => {
    const token = await registerUser();
    await request(app)
      .post("/api/ark/portrait/invite")
      .set("Authorization", `Bearer ${token}`)
      .send({ days: 9999 })
      .expect(400);
  });

  test("配了 AK/SK 时真发签名请求，但不真出网；签名头形状正确", async () => {
    process.env.VOLC_AK = "AKtesttesttesttesttest";
    process.env.VOLC_SK = "c2tzZWNyZXR0ZXN0dGVzdHRlc3Q=";
    // fetch 间谍：拦住出网，回一个假的方舟成功响应
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return {
        status: 200,
        json: async () => ({ ResponseMetadata: { RequestId: "test-req" }, Result: { UUID: "test-uuid-1234" } }),
      };
    };
    try {
      const token = await registerUser();
      const r = await request(app)
        .post("/api/ark/portrait/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ days: 7 })
        .expect(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.uuid).toBe("test-uuid-1234");
      expect(r.body.url).toContain("test-uuid-1234");
      // 有效期是秒级、跨度 = 7 天
      expect(r.body.endSec - r.body.startSec).toBe(7 * 24 * 3600);

      // 确实打的是 open.volcengineapi.com，且带齐 V4 的四个签名头
      expect(String(captured.url)).toContain("open.volcengineapi.com");
      expect(String(captured.url)).toContain("Action=CreateAuthorizationUUID");
      const h = captured.init.headers;
      expect(h["X-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(h["X-Content-Sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(h.Authorization).toMatch(/^HMAC-SHA256 Credential=AKtest.*\/\d{8}\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
      // 请求体就是实证过的那个形状
      expect(JSON.parse(captured.init.body)).toEqual({ Validity: { Start: expect.any(Number), End: expect.any(Number) } });
    } finally {
      global.fetch = realFetch;
      delete process.env.VOLC_AK;
      delete process.env.VOLC_SK;
    }
  });

  test("/portrait/assets 打的是 ListAssets，入参三件套齐（GroupType/PageNumber/PageSize）", async () => {
    process.env.VOLC_AK = "AKtest";
    process.env.VOLC_SK = "sktest";
    const realFetch = global.fetch;
    let captured = null;
    global.fetch = async (url, init) => {
      captured = { url, init };
      return { status: 200, json: async () => ({ Result: { Items: [], TotalCount: 0 } }) };
    };
    try {
      const token = await registerUser();
      await request(app).get("/api/ark/portrait/assets").set("Authorization", `Bearer ${token}`).expect(200);
      expect(String(captured.url)).toContain("Action=ListAssets");
      // 少任何一件方舟都 400（逐个实证过），所以这三件在测试里钉死
      expect(JSON.parse(captured.init.body)).toEqual({
        Filter: { GroupType: "LivenessFace" },
        PageNumber: 1,
        PageSize: 50,
      });

      // 带 groupId 时进 Filter.GroupId（单数——实测生效的是这个形式）
      await request(app)
        .get("/api/ark/portrait/assets?groupId=group-20260828131552-jlbz5")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(JSON.parse(captured.init.body).Filter).toEqual({
        GroupType: "LivenessFace",
        GroupId: "group-20260828131552-jlbz5",
      });
    } finally {
      global.fetch = realFetch;
      delete process.env.VOLC_AK;
      delete process.env.VOLC_SK;
    }
  });

  test("素材的审核失败原因必须一路透到 app；肖像原图直链必须被挡在服务端", async () => {
    process.env.VOLC_AK = "AKtest";
    process.env.VOLC_SK = "sktest";
    const realFetch = global.fetch;
    // 真实回包（2026-08-28 实测那一发）的形状
    global.fetch = async () => ({
      status: 200,
      json: async () => ({
        Result: {
          Items: [
            {
              Id: "asset-20260828131637-4872q",
              Name: "1787559250952.jpeg",
              URL: "https://ark-media-asset.tos-cn-beijing.volces.com/2130650312/xxx.jpeg?X-Tos-Signature=deadbeef",
              AssetType: "Image",
              GroupId: "group-20260828131552-jlbz5",
              Status: "Failed",
              Error: {
                Code: "InputImageSensitiveContentDetected.PolicyViolation",
                Message: "The request failed because the input image may be related to copyright restrictions.",
              },
              CreateTime: "2026-08-28T05:16:37Z",
            },
          ],
          TotalCount: 1,
        },
      }),
    });
    try {
      const token = await registerUser();
      const r = await request(app)
        .get("/api/ark/portrait/assets")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      const it = r.body.items[0];
      expect(it.id).toBe("asset-20260828131637-4872q");
      expect(it.status).toBe("Failed");
      // ★ 原因不许被吞：吞了用户就只会看到"授权成功但用不了"（铁律八）
      expect(it.error.code).toBe("InputImageSensitiveContentDetected.PolicyViolation");
      expect(it.error.message).toMatch(/copyright/);
      // ★★ 签名直链指向的是**某个真人的肖像原图**，一个字节都不许出服务端
      expect(it.URL).toBeUndefined();
      expect(it.url).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toContain("X-Tos-Signature");
      expect(JSON.stringify(r.body)).not.toContain("tos-cn-beijing");
    } finally {
      global.fetch = realFetch;
      delete process.env.VOLC_AK;
      delete process.env.VOLC_SK;
    }
  });

  test("火山返回业务错时原样透出（502 + 火山的 Code/Message，不替它翻译）", async () => {
    process.env.VOLC_AK = "AKtest";
    process.env.VOLC_SK = "sktest";
    const realFetch = global.fetch;
    global.fetch = async () => ({
      status: 400,
      json: async () => ({ ResponseMetadata: { RequestId: "r2", Error: { Code: "InvalidParameter.Validity.Start", Message: "invalid" } } }),
    });
    try {
      const token = await registerUser();
      const r = await request(app)
        .post("/api/ark/portrait/invite")
        .set("Authorization", `Bearer ${token}`)
        .send({ days: 7 })
        .expect(502);
      expect(r.body.code).toBe("InvalidParameter.Validity.Start");
      expect(r.body.requestId).toBe("r2");
    } finally {
      global.fetch = realFetch;
      delete process.env.VOLC_AK;
      delete process.env.VOLC_SK;
    }
  });
});

describe("V4 签名 · 确定性（同参同时同签名，改一字节即变）", () => {
  test("callOpenApi 的签名可复现", () => {
    process.env.VOLC_AK = "AKfixed";
    process.env.VOLC_SK = "skfixed";
    // 冻结时间，让 X-Date 固定
    const RealDate = Date;
    const FIXED = new RealDate("2026-08-27T08:00:00Z");
    global.Date = class extends RealDate {
      constructor(...a) {
        return a.length ? new RealDate(...a) : FIXED;
      }
      static now() {
        return FIXED.getTime();
      }
    };
    const caps = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      caps.push(init.headers.Authorization);
      return { status: 200, json: async () => ({ Result: {} }) };
    };
    try {
      // 复用服务层，绕过 HTTP 栈
      jest.resetModules();
      const svc = require("../src/services/arkOpenApi.service");
      return Promise.all([
        svc.callOpenApi("PingA", { x: 1 }),
        svc.callOpenApi("PingA", { x: 1 }),
        svc.callOpenApi("PingA", { x: 2 }),
      ]).then(() => {
        expect(caps[0]).toBe(caps[1]); // 同参同时 → 同签名
        expect(caps[0]).not.toBe(caps[2]); // body 改了 → 签名变
      });
    } finally {
      global.Date = RealDate;
      global.fetch = realFetch;
      delete process.env.VOLC_AK;
      delete process.env.VOLC_SK;
    }
  });
});
