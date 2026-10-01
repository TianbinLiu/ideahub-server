/**
 * TUTOR_ENABLED=true：/api/tutor 挂上了 —— /health 不鉴权可达（只看 aiConfig 与 demoAllowed，不碰 Mongo），/config 没登录 401。
 * 与 tutorFlagOff.spec 分文件的原因见那边头部。
 */
const request = require("supertest");

let app;
beforeAll(() => {
  process.env.TUTOR_ENABLED = "true";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  app = require("../src/app");
});
afterAll(() => { delete process.env.TUTOR_ENABLED; });

it("开关开着：/api/tutor/health 200 { ok, tutor:true }；/api/tutor/config 没带 token 401", async () => {
  const h = await request(app).get("/api/tutor/health");
  expect(h.status).toBe(200);
  expect(h.body).toMatchObject({ ok: true, tutor: true });
  const c = await request(app).get("/api/tutor/config");
  expect(c.status).toBe(401);
});
