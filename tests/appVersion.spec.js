// tests/appVersion.spec.js
// App 的版本头 `X-App-Version: <versionName>+<versionCode>`（App 2.63 起每个发往我们 API 的请求都带）。
//
// ★★ 这一份最要紧的是 CORS 那一组：App 的 WebView 源是 https://localhost，打 api 是跨域的；带自定义请求头的请求
//   浏览器先发 OPTIONS 预检。预检不放这个头 = 2.63 起**每一个**请求都被浏览器拦下、App 整个连不上服务器，
//   而服务端日志里一行都没有（预检在 cors 中间件那里就答完了）。今天它能过，是因为 app.js 的 cors() 没写
//   allowedHeaders（= 原样反射预检要的头）；哪天有人把它收紧成白名单、漏了这个头，这里会红。
// ★ 解析只给日志用（middleware/appVersion 文件头）：写法不对就当没带，不拒请求。
const request = require("supertest");
const express = require("express");
const { parseAppVersion, appVersion } = require("../src/middleware/appVersion");

describe("解析（parseAppVersion）", () => {
  test("正常写法：正式包 / debug 包 / 前后空格", () => {
    expect(parseAppVersion("2.63+75")).toEqual({ name: "2.63", code: 75, raw: "2.63+75" });
    expect(parseAppVersion("2.63-debug+75")).toEqual({ name: "2.63-debug", code: 75, raw: "2.63-debug+75" });
    expect(parseAppVersion("  2.63+75 ")).toEqual({ name: "2.63", code: 75, raw: "2.63+75" });
  });

  test("写法不对一律当没带（null），不抛", () => {
    for (const v of [undefined, null, 75, {}, "", " ", "2.63", "+75", "2.63+", "2.63+7.5", "2.63+-1", "v2.63+75", "2.63 +75", "2.63+75+1", "<b>+1", `2.${"6".repeat(40)}+75`]) {
      expect(parseAppVersion(v)).toBeNull();
    }
  });

  test("中间件把它挂在 req.appVersion 上（没带 = null），不影响请求本身", async () => {
    const mini = express();
    mini.use(appVersion);
    mini.get("/echo", (req, res) => res.json({ v: req.appVersion }));
    expect((await request(mini).get("/echo").set("X-App-Version", "2.63+75").expect(200)).body).toEqual({
      v: { name: "2.63", code: 75, raw: "2.63+75" },
    });
    expect((await request(mini).get("/echo").expect(200)).body).toEqual({ v: null });
    expect((await request(mini).get("/echo").set("X-App-Version", "garbage").expect(200)).body).toEqual({ v: null });
  });
});

describe("CORS 预检放行 X-App-Version（真的 app.js，白名单里有 App 的源）", () => {
  let app;
  const saved = {};

  beforeAll(() => {
    // 照生产的形状配白名单：App 的 WebView 源 + 官网。allowedOrigins 在 app.js 加载那一刻读 env，所以先配再 require
    for (const k of ["CORS_ORIGINS", "JWT_SECRET"]) saved[k] = process.env[k];
    process.env.CORS_ORIGINS = "https://localhost,https://ideahubs.org";
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
    jest.isolateModules(() => {
      app = require("../src/app");
    });
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const preflight = (path, origin, headers) =>
    request(app)
      .options(path)
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", headers);

  test.each([["/api/ark/images/generations"], ["/api/ark/image-groups"], ["/api/me/wallet"], ["/api/health"]])(
    "%s：App 的源带 authorization + content-type + x-app-version 预检 → 204，三个头都放行",
    async (path) => {
      const res = await preflight(path, "https://localhost", "authorization,content-type,x-app-version").expect(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
      const allowed = String(res.headers["access-control-allow-headers"] || "")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim());
      expect(allowed).toEqual(expect.arrayContaining(["authorization", "content-type", "x-app-version"]));
    },
  );

  // ★ 预检要让浏览器记住：不带 Access-Control-Max-Age 时 Chromium（App 的 WebView）只记 5 秒，而 2.63 起每个请求都带
  //   版本头 = 每个请求都要预检 —— 原来不用预检的 GET（没登录刷首页、探能力）几乎每一发都多一趟往返（理由见 app.js 的 cors()）。
  test("预检带 Access-Control-Max-Age: 7200（Chromium 的上限），GET 带版本头的预检也一样", async () => {
    const res = await preflight("/api/ark/images/generations", "https://localhost", "authorization,content-type,x-app-version").expect(204);
    expect(res.headers["access-control-max-age"]).toBe("7200");
    const get = await request(app)
      .options("/api/ark/health")
      .set("Origin", "https://localhost")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "x-app-version")
      .expect(204);
    expect(get.headers["access-control-max-age"]).toBe("7200");
  });

  // 余额头顺手钉住：收紧 CORS 时最容易和版本头一起弄丢
  test("实际请求带着版本头照常通（不因为这个头被拒），且余额头仍在 exposedHeaders 里", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://localhost").set("X-App-Version", "2.63+75").expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(String(res.headers["access-control-expose-headers"] || "")).toContain("X-Wallet-Plan");
  });

  test("白名单外的源：预检照旧不给 Allow-Origin（这次没有顺手把 CORS 放宽）", async () => {
    const res = await preflight("/api/health", "https://evil.example", "x-app-version");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
