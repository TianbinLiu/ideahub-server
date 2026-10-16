// tests/clientEvents.spec.js
// POST /api/client-events（2026-10-15 起 App 自报白屏 / 没接住的 Promise / 更新失败 / IndexedDB 丢数据 / 开机被拦）。
// 钉四件事：形状（204 / 400）、免登录、按 IP 限流（429）、能力位（/api/ark/health 的 clientEvents: true —— App 见不到就不发）。
// 为什么只写日志、为什么免登录：routes/clientEvents.routes.js 文件头。
const request = require("supertest");
const express = require("express");

const good = { kind: "render-error", version: "2.64+76", where: "/studio", name: "TypeError" };

describe("真的 app.js：挂在 /api/client-events，免登录，只写一行日志", () => {
  let app;
  const warnings = [];
  let warnSpy;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
    app = require("../src/app");
    warnSpy = jest.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.join(" "));
    });
  });
  afterAll(() => warnSpy.mockRestore());
  beforeEach(() => {
    warnings.length = 0;
  });
  const logged = () => warnings.filter((w) => w.startsWith("[client-event]"));

  test("合形状 → 204、无正文、不要登录；一行 [client-event] 日志带 kind / version / where / name / ip（ip 走 clientIp：X-Real-IP 优先）", async () => {
    const res = await request(app).post("/api/client-events").set("X-Real-IP", "203.0.113.7").send(good).expect(204);
    expect(res.body).toEqual({});
    expect(logged()).toEqual(["[client-event] kind=render-error version=2.64+76 where=/studio name=TypeError ip=203.0.113.7"]);
  });

  test("可选字段不带 → 日志里写 -；多余的键被剥掉、不报错", async () => {
    await request(app).post("/api/client-events").send({ kind: "boot-blocked", version: "2.64-debug+76", extra: "x" }).expect(204);
    expect(logged()[0]).toMatch(/^\[client-event\] kind=boot-blocked version=2\.64-debug\+76 where=- name=- ip=\S+$/);
  });

  test("version 里夹换行 / 控制字符：日志仍是一行（伪造不出第二行）", async () => {
    await request(app).post("/api/client-events").send({ kind: "update-failed", version: "2.64+76\n[http] 500 forged" }).expect(204);
    const [line] = logged();
    expect(line).not.toContain("\n");
    expect(line).toContain("version=2.64+76?[http]?500?forged");
  });

  test.each([
    ["kind 不在白名单", { ...good, kind: "crash" }],
    ["缺 kind", { version: "2.64+76" }],
    ["缺 version", { kind: "render-error" }],
    ["version 空串", { ...good, version: "" }],
    ["version 超过 40", { ...good, version: "2.".repeat(21) }],
    ["where 超过 64", { ...good, where: `/${"a".repeat(64)}` }],
    ["where 带空格 / 尖括号", { ...good, where: "/studio <b>" }],
    ["name 带斜杠", { ...good, name: "Type/Error" }],
    ["不是对象（数组）", []],
  ])("%s → 400 VALIDATION_ERROR，不写日志", async (_label, body) => {
    const res = await request(app).post("/api/client-events").send(body).expect(400);
    expect(res.body).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(logged()).toEqual([]);
  });

  test("能力位：GET /api/ark/health 带 clientEvents: true（App 见不到这一位就不发）", async () => {
    const res = await request(app).get("/api/ark/health").expect(200);
    expect(res.body).toMatchObject({ ok: true, clientEvents: true });
  });
});

// 限流器在 NODE_ENV=test 下整体关闭（middleware/rateLimit 文件头），所以这一组在 NODE_ENV 不是 test 的模块注册表里装路由：
// 只装这一个路由（不是整个 app.js），限流走没有 Redis 的进程内回退 —— 测的是「这个端点挂了按 IP 的闸、阈值是 10」。
describe("按 IP 限流：10 次/分钟", () => {
  let mini;
  let warnSpy;

  beforeAll(() => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    let router;
    try {
      jest.isolateModules(() => {
        router = require("../src/routes/clientEvents.routes");
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
    const { errorHandler } = require("../src/middleware/error");
    mini = express();
    mini.use(express.json());
    mini.use("/api/client-events", router);
    mini.use(errorHandler);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(() => warnSpy.mockRestore());

  test("同一个 IP 第 11 次 → 429 RATE_LIMIT_EXCEEDED + Retry-After；另一个 IP 不受影响", async () => {
    const from = (ip) => request(mini).post("/api/client-events").set("X-Real-IP", ip).send(good);
    for (let i = 0; i < 10; i++) await from("203.0.113.10").expect(204);
    const res = await from("203.0.113.10").expect(429);
    expect(res.body).toMatchObject({ ok: false, code: "RATE_LIMIT_EXCEEDED" });
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    await from("203.0.113.11").expect(204);
  });
});
