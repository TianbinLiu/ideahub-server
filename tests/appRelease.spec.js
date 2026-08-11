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
