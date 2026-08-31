// tests/arkPortraitImage.spec.js
// 授权素材图片这条路的 Content-Type —— 钉住 2026-09-01 那个"零报错、照片一直都在"的 bug。
//
// ★★ 方舟素材桶（TOS）回的是 `binary/octet-stream`。原样透传的后果不是"类型标错了"：
//   客户端 `new File([blob], …, { type: blob.type || "image/jpeg" })` 的兜底对它**不生效**
//   （真值，只是不对），File 带着它进 decodeImageFile，那里 `!type.startsWith("image/")`
//   当场 throw「请选择图片文件」⇒ 用户看到「没取到授权照片（请选择图片文件）」，
//   而照片好好地在方舟上。全程零报错、零日志。
const request = require("supertest");
const express = require("express");

describe("授权素材图片的 Content-Type", () => {
  const ASSET = { Id: "asset-x", Name: "a.jpg", AssetType: "Image", Status: "Active", URL: "https://tos.example.com/a" };

  function appWith(upstreamContentType) {
    jest.resetModules();
    jest.doMock("../src/services/arkOpenApi.service", () => ({
      openApiConfigured: () => true,
      listPortraitAssets: async () => ({ ok: true, result: { Items: [ASSET] } }),
      createPortraitInvite: async () => ({ ok: true, result: {} }),
      listPortraitGroups: async () => ({ ok: true, result: { Items: [], TotalCount: 0 } }),
    }));
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? upstreamContentType : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });
    const app = express();
    // requireAuth 直接放行：这条用例测的是 Content-Type，不是鉴权
    jest.doMock("../src/middleware/auth", () => ({
      requireAuth: (req, _res, next) => { req.user = { _id: "u1" }; next(); },
      optionalAuth: (req, _res, next) => next(),
    }));
    app.use("/api/ark", require("../src/routes/arkPortrait.routes"));
    return app;
  }

  test("上游给 binary/octet-stream 时，我们必须改成 image/jpeg", async () => {
    const res = await request(appWith("binary/octet-stream"))
      .get("/api/ark/portrait/assets/asset-x/image")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
  });

  test("上游给了真的 image/* 就照用（别把 png 改成 jpeg）", async () => {
    const res = await request(appWith("image/png"))
      .get("/api/ark/portrait/assets/asset-x/image")
      .expect(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
  });

  test("私人肖像任何一层都不许缓存", async () => {
    const res = await request(appWith("image/jpeg"))
      .get("/api/ark/portrait/assets/asset-x/image")
      .expect(200);
    expect(res.headers["cache-control"]).toContain("no-store");
  });
});
