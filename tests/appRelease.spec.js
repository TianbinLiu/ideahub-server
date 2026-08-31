// tests/appRelease.spec.js
// 覆盖：安卓 App 的版本清单端点 GET /api/app/latest.json。
//
// ★ 这套用例盯的是一类【坏了也没有症状】的问题：App 的检查更新失败是**静默的**
//   （查不到就当没有新版，不打扰用户）。所以这个端点一旦回错、回 5xx 或者
//   回一份过期的东西，表现都是"大家再也收不到更新"，而没有任何人会来报错。
const express = require("express");
const request = require("supertest");

const MANIFEST = {
  versionCode: 42,
  versionName: "9.9",
  apkUrl: "https://github.com/o/r/releases/download/v9.9/qimeng-9.9.apk",
  sizeBytes: 123,
  sha256: "abc",
  notes: "x",
};

/** 每个用例都要一份**全新**的路由模块：缓存是模块级的，串了就测不出真东西 */
function freshApp(env = {}) {
  jest.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const router = require("../src/routes/appRelease.routes");
  const app = express();
  app.use("/api/app", router);
  process.env = saved;
  return app;
}

let fetchMock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

const ok = (body = MANIFEST) => ({ ok: true, status: 200, json: async () => body });

describe("App 版本清单", () => {
  test("A1 正常回上游那份，原样不改", async () => {
    fetchMock.mockResolvedValue(ok());
    const res = await request(freshApp()).get("/api/app/latest.json").expect(200);
    expect(res.body.versionCode).toBe(42);
    expect(res.body.apkUrl).toBe(MANIFEST.apkUrl);
    expect(res.headers["x-manifest-cache"]).toBe("miss");
  });

  test("A2 60 秒内命中缓存，不重复打上游", async () => {
    fetchMock.mockResolvedValue(ok());
    const app = freshApp();
    await request(app).get("/api/app/latest.json").expect(200);
    const res = await request(app).get("/api/app/latest.json").expect(200);
    expect(res.headers["x-manifest-cache"]).toBe("hit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("A3 上游挂了：发旧的，**不能 5xx**", async () => {
    // ★ 这条是重点。回 502 的话 App 侧检查更新失败——而那是静默的，
    //   用户永远不知道有新版。宁可给一份一天以内的旧清单。
    const app = freshApp();
    fetchMock.mockResolvedValueOnce(ok());
    await request(app).get("/api/app/latest.json").expect(200);

    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000); // 缓存已过期
    fetchMock.mockRejectedValue(new Error("boom"));
    const res = await request(app).get("/api/app/latest.json").expect(200);
    expect(res.body.versionCode).toBe(42);
    expect(res.headers["x-manifest-cache"]).toBe("stale");
    Date.now.mockRestore();
  });

  test("A4 上游挂了且一份缓存都没有：503，而不是假装没有新版", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const res = await request(freshApp()).get("/api/app/latest.json").expect(503);
    expect(res.body.ok).toBe(false);
  });

  test("A5 上游回的东西不像清单，一律当失败", async () => {
    // 最容易发生的一种：GitHub 回了一页 HTML（限流/改版），JSON 解析侥幸没炸
    fetchMock.mockResolvedValue(ok({ hello: "world" }));
    await request(freshApp()).get("/api/app/latest.json").expect(503);
  });

  test("A6 配了 APP_APK_BASE 就改写下载地址，文件名保持不变", async () => {
    // 这条是这个端点存在的第二个理由：换 CDN 不用重新出包
    fetchMock.mockResolvedValue(ok());
    const app = freshApp({ APP_APK_BASE: "https://cdn.example.com/app/" });
    const res = await request(app).get("/api/app/latest.json").expect(200);
    expect(res.body.apkUrl).toBe("https://cdn.example.com/app/qimeng-9.9.apk");
    expect(res.body.versionCode).toBe(42); // 别的字段一个都不许动
    expect(res.body.sha256).toBe("abc");
  });
});

describe("App 下载跳转", () => {
  // 官网下载页的按钮打的是 /api/app/download。它和 latest.json 的区别只有一个：
  // **地址里不带版本号**，所以它会被印在海报、二维码、聊天记录里长期流传 ——
  // 坏了的表现是「按钮点了没反应 / 下到的是旧包」，同样没有人会来报。

  test("B1 302 到清单里的安装包", async () => {
    fetchMock.mockResolvedValue(ok());
    const res = await request(freshApp()).get("/api/app/download").expect(302);
    expect(res.headers.location).toBe(MANIFEST.apkUrl);
  });

  test("B2 跳转**不许**被缓存住", async () => {
    // ★ 这条跳转的指向会随发版改变。浏览器或线上那层 Cloudflare 一旦把 302 存下来，
    //   点过一次的人就被钉死在旧版本上了，而且是静默的。
    fetchMock.mockResolvedValue(ok());
    const res = await request(freshApp()).get("/api/app/download").expect(302);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("B3 换源开关对下载跳转同样生效", async () => {
    // 两个端点必须给出同一个地址，否则「页面显示的包」和「点下载拿到的包」会分家
    fetchMock.mockResolvedValue(ok());
    const app = freshApp({ APP_APK_BASE: "https://cdn.example.com/app/" });
    const res = await request(app).get("/api/app/download").expect(302);
    expect(res.headers.location).toBe("https://cdn.example.com/app/qimeng-9.9.apk");
  });

  test("B4 和 latest.json 共用同一份缓存，不各拉各的", async () => {
    // 分开缓存 = 两边可能停在不同版本上：页面写着新版，点下载给的是旧包
    fetchMock.mockResolvedValue(ok());
    const app = freshApp();
    await request(app).get("/api/app/latest.json").expect(200);
    await request(app).get("/api/app/download").expect(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("B5 上游挂了：用旧清单照样能下，不能把人挡在门外", async () => {
    const app = freshApp();
    fetchMock.mockResolvedValueOnce(ok());
    await request(app).get("/api/app/download").expect(302);

    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000); // 缓存已过期
    fetchMock.mockRejectedValue(new Error("boom"));
    const res = await request(app).get("/api/app/download").expect(302);
    expect(res.headers.location).toBe(MANIFEST.apkUrl);
    Date.now.mockRestore();
  });

  test("B6 上游挂了且一份缓存都没有：503，不能把人送去一个瞎猜的地址", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const res = await request(freshApp()).get("/api/app/download").expect(503);
    expect(res.body.ok).toBe(false);
  });

  test("B7 清单里的地址不是 http(s) 就拒绝跳转", async () => {
    // 匿名端点上的可控跳转 = 开放重定向；这里只挡协议，因为清单是自家发布产物
    fetchMock.mockResolvedValue(ok({ ...MANIFEST, apkUrl: "javascript:alert(1)" }));
    const res = await request(freshApp()).get("/api/app/download").expect(502);
    expect(res.body.code).toBe("BAD_MANIFEST");
  });
});

// ★★ 安装包这一路的**可缓存性**（2026-08-31 实测定位后钉住）。
//   全局 CORS 中间件给每个响应加 `Vary: Origin`，而**带 Vary 的响应 Cloudflare 不缓存**
//   ⇒ 每一次下载都回源拉 61MB。实测：源站本机读 141MB/s，客户端经 CF 整包只有 136KB/s，
//   而同一条链路上命中缓存的小片段有 1.95MB/s —— 差的正是"有没有命中边缘缓存"。
//   这条用例挡的是"以后有人给这条路加回 CORS / 加个 Vary"。
describe("安装包镜像的可缓存性", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const cors = require("cors");

  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apk-"));
    fs.writeFileSync(path.join(dir, "qimeng-9.99.apk"), Buffer.alloc(1024, 7));
  });

  /** 带上全局那份 CORS —— 线上就是这么挂的，不带的话这条用例测了个寂寞 */
  function appWithCors() {
    jest.resetModules();
    const saved = { ...process.env };
    process.env.APP_APK_DIR = dir;
    const router = require("../src/routes/appRelease.routes");
    const app = express();
    app.use(cors({ origin: true, credentials: false }));
    app.use("/api/app", router);
    process.env = saved;
    return app;
  }

  test("F1 安装包响应**不带 Vary**（带了 CF 就不缓存），且 Cache-Control / MIME / Range 都对", async () => {
    const res = await request(appWithCors())
      .get("/api/app/file/qimeng-9.99.apk")
      .set("Origin", "https://example.com")
      .expect(200);
    expect(res.headers.vary).toBeUndefined();
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["content-type"]).toContain("android.package-archive");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  test("F2 断点续传可用（206 + Content-Range）—— 慢链路上断一次不用从头再来", async () => {
    const res = await request(appWithCors())
      .get("/api/app/file/qimeng-9.99.apk")
      .set("Range", "bytes=0-99")
      .expect(206);
    expect(res.headers["content-range"]).toBe("bytes 0-99/1024");
  });
});

