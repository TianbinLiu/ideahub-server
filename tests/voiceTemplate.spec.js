/**
 * 声音市场（/api/voice-templates）契约测试：创建时的配方归一 / 2.0 拒收 / 条数上限、列表可见性、详情 403、
 * 点赞开关、使用计数、{ templateId } 展开、删除后引用方 templateId 置空而配方快照保留。
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createUser(prefix = "vt") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  return { user, token: signToken(user) };
}

// 三味验证过的 1.0 音色 + 一味 2.0（混不了）
const F = "zh_female_gaolengyujie_moon_bigtts";
const M = "zh_male_shaonianzixin_moon_bigtts";
const C = "zh_female_cancan_mars_bigtts";
const V2 = "zh_female_vv_uranus_bigtts";
const sumWeights = (list) => +list.reduce((a, m) => a + m.weight, 0).toFixed(3);

async function createTemplate(token, body = {}) {
  const res = await request(app)
    .post("/api/voice-templates")
    .set(auth(token))
    .send({ name: "御姐少年", recipe: [{ voiceId: F, weight: 2 }, { voiceId: M, weight: 1 }], shared: true, ...body });
  expect(res.status).toBe(201);
  return res.body.template;
}

describe("POST /api/voice-templates", () => {
  it("未登录 401；创建成功：权重归一（和 = 1、三位小数）、voice 快照的 templateId 指回模板", async () => {
    expect((await request(app).post("/api/voice-templates").send({ name: "x", recipe: [{ voiceId: F, weight: 1 }] })).status).toBe(401);

    const { user, token } = await createUser();
    const t = await createTemplate(token, {
      name: "三味",
      description: "试试",
      recipe: [{ voiceId: F, weight: 1 }, { voiceId: M, weight: 1 }, { voiceId: C, weight: 1 }],
      rate: -10,
      pitch: 2,
      instruct: "轻一点",
      expressive: false,
    });
    expect(t).toMatchObject({
      name: "三味",
      description: "试试",
      rate: -10,
      pitch: 2,
      instruct: "轻一点",
      expressive: false,
      shared: true,
      isOwner: true,
      liked: false,
      stats: { useCount: 0, likeCount: 0 },
    });
    expect(t.author).toEqual({ _id: String(user._id), username: user.username });
    // 三个 1/3 逐个四舍五入是 0.999，零头记到最后一味
    expect(t.recipe).toEqual([{ voiceId: F, weight: 0.333 }, { voiceId: M, weight: 0.333 }, { voiceId: C, weight: 0.334 }]);
    expect(sumWeights(t.recipe)).toBe(1);
    expect(t.voice).toEqual({ voiceId: "", mix: t.recipe, templateId: t._id, rate: -10, pitch: 2, instruct: "轻一点", expressive: false });
    expect(typeof t.createdAt).toBe("string");
  });

  it("2.0 音色进配方 → 400 VALIDATION_ERROR 且 message 说明只能混 1.0；4 味 / 空配方 → 400；老形状 {id,w} 与重复音色都能收", async () => {
    const { token } = await createUser();
    const v2 = await request(app)
      .post("/api/voice-templates")
      .set(auth(token))
      .send({ name: "x", recipe: [{ voiceId: F, weight: 1 }, { voiceId: V2, weight: 1 }] });
    expect(v2.status).toBe(400);
    expect(v2.body.code).toBe("VALIDATION_ERROR");
    expect(v2.body.message).toMatch(/1\.0/);
    expect(v2.body.message).toContain(V2);

    const four = await request(app)
      .post("/api/voice-templates")
      .set(auth(token))
      .send({ name: "x", recipe: [F, M, C, "zh_female_meilinvyou_moon_bigtts"].map((voiceId) => ({ voiceId, weight: 1 })) });
    expect(four.status).toBe(400);
    expect(four.body.code).toBe("VALIDATION_ERROR");

    const empty = await request(app).post("/api/voice-templates").set(auth(token)).send({ name: "x", recipe: [] });
    expect(empty.status).toBe(400);
    const zero = await request(app).post("/api/voice-templates").set(auth(token)).send({ name: "x", recipe: [{ voiceId: F, weight: 0 }] });
    expect(zero.status).toBe(400);
    const longName = await request(app).post("/api/voice-templates").set(auth(token)).send({ name: "x".repeat(61), recipe: [{ voiceId: F, weight: 1 }] });
    expect(longName.status).toBe(400);

    const legacy = await createTemplate(token, { recipe: [{ id: F, w: 3 }, { id: M, w: 1 }] });
    expect(legacy.recipe).toEqual([{ voiceId: F, weight: 0.75 }, { voiceId: M, weight: 0.25 }]);
    const dup = await createTemplate(token, { recipe: [{ voiceId: F, weight: 1 }, { voiceId: F, weight: 1 }, { voiceId: M, weight: 2 }] });
    expect(dup.recipe).toEqual([{ voiceId: F, weight: 0.5 }, { voiceId: M, weight: 0.5 }]);
  });
});

describe("列表 / 详情 / 点赞 / 使用 / 修改 / 删除", () => {
  it("scope=all 只有已分享的；scope=mine 含私有、未登录 401；私有详情非作者 403；q 搜索；limit 上限", async () => {
    const a = await createUser("la");
    const b = await createUser("lb");
    const pub = await createTemplate(a.token, { name: "公开配方" });
    const priv = await createTemplate(a.token, { name: "私有配方", shared: false });

    const list = await request(app).get("/api/voice-templates");
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, page: 1, limit: 12, total: expect.any(Number), totalPages: expect.any(Number) });
    const names = list.body.templates.map((t) => t.name);
    expect(names).toContain("公开配方");
    expect(names).not.toContain("私有配方");
    expect(list.body.templates.every((t) => t.shared && t.isOwner === false && t.liked === false)).toBe(true);

    const mine = await request(app).get("/api/voice-templates?scope=mine").set(auth(a.token));
    expect(mine.body.templates.map((t) => t.name).sort()).toEqual(["公开配方", "私有配方"]);
    expect(mine.body.templates.every((t) => t.isOwner)).toBe(true);
    expect((await request(app).get("/api/voice-templates?scope=mine")).status).toBe(401);
    expect((await request(app).get("/api/voice-templates?scope=mine").set(auth(b.token))).body.templates).toEqual([]);

    expect((await request(app).get(`/api/voice-templates/${priv._id}`).set(auth(b.token))).status).toBe(403);
    expect((await request(app).get(`/api/voice-templates/${priv._id}`)).status).toBe(403);
    const own = await request(app).get(`/api/voice-templates/${priv._id}`).set(auth(a.token));
    expect(own.status).toBe(200);
    expect(own.body.template).toMatchObject({ name: "私有配方", isOwner: true, shared: false });
    const seen = await request(app).get(`/api/voice-templates/${pub._id}`).set(auth(b.token));
    expect(seen.status).toBe(200);
    expect(seen.body.template).toMatchObject({ name: "公开配方", isOwner: false });
    expect((await request(app).get(`/api/voice-templates/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    expect((await request(app).get("/api/voice-templates/not-an-id")).status).toBe(400);

    const q = await request(app).get(`/api/voice-templates?q=${encodeURIComponent("公开")}`);
    expect(q.body.templates.map((t) => t.name)).toEqual(["公开配方"]);
    expect((await request(app).get("/api/voice-templates?limit=99")).status).toBe(400);
    expect((await request(app).get("/api/voice-templates?sort=weird")).status).toBe(400);
  });

  it("点赞开关；use 计数递增；私有模板别人不能点赞 / 使用；sort=hot 按 useCount", async () => {
    const a = await createUser("ua");
    const b = await createUser("ub");
    const hotOne = await createTemplate(a.token, { name: "热门" });
    await createTemplate(a.token, { name: "冷门" });

    expect((await request(app).post(`/api/voice-templates/${hotOne._id}/like`)).status).toBe(401);
    const like = await request(app).post(`/api/voice-templates/${hotOne._id}/like`).set(auth(b.token));
    expect(like.body).toEqual({ ok: true, liked: true, likeCount: 1 });
    const detail = await request(app).get(`/api/voice-templates/${hotOne._id}`).set(auth(b.token));
    expect(detail.body.template.liked).toBe(true);
    expect(detail.body.template.stats.likeCount).toBe(1);
    const unlike = await request(app).post(`/api/voice-templates/${hotOne._id}/like`).set(auth(b.token));
    expect(unlike.body).toEqual({ ok: true, liked: false, likeCount: 0 });

    const use1 = await request(app).post(`/api/voice-templates/${hotOne._id}/use`).set(auth(b.token));
    expect(use1.body).toEqual({ ok: true, useCount: 1 });
    const use2 = await request(app).post(`/api/voice-templates/${hotOne._id}/use`).set(auth(b.token));
    expect(use2.body.useCount).toBe(2);
    expect((await request(app).post(`/api/voice-templates/${hotOne._id}/use`)).status).toBe(401);

    const hot = await request(app).get("/api/voice-templates?sort=hot");
    const idx = (name) => hot.body.templates.findIndex((t) => t.name === name);
    expect(idx("热门")).toBe(0);
    expect(hot.body.templates[0].stats.useCount).toBe(2);
    expect(idx("冷门")).toBeGreaterThan(0);

    const priv = await createTemplate(a.token, { name: "私", shared: false });
    expect((await request(app).post(`/api/voice-templates/${priv._id}/like`).set(auth(b.token))).status).toBe(403);
    expect((await request(app).post(`/api/voice-templates/${priv._id}/use`).set(auth(b.token))).status).toBe(403);
    expect((await request(app).post(`/api/voice-templates/${priv._id}/use`).set(auth(a.token))).body.useCount).toBe(1);
  });

  it("{ templateId } 展开：公开的 / 自己的可以；私有他人的 403；不存在 404；显式 rate 覆盖模板的", async () => {
    const a = await createUser("ea");
    const b = await createUser("eb");
    const priv = await createTemplate(a.token, { shared: false, rate: -20, instruct: "沉一点" });
    expect((await request(app).put("/api/companion/settings").set(auth(b.token)).send({ voice: { templateId: priv._id } })).status).toBe(403);
    const missing = await request(app)
      .put("/api/companion/settings")
      .set(auth(b.token))
      .send({ voice: { templateId: new mongoose.Types.ObjectId().toString() } });
    expect(missing.status).toBe(404);
    expect((await request(app).put("/api/companion/settings").set(auth(b.token)).send({ voice: { templateId: "nope" } })).status).toBe(400);

    const own = await request(app).put("/api/companion/settings").set(auth(a.token)).send({ voice: { templateId: priv._id, rate: 30 } });
    expect(own.status).toBe(200);
    expect(own.body.settings.voice).toEqual({ voiceId: "", mix: priv.recipe, templateId: priv._id, rate: 30, pitch: null, instruct: "沉一点", expressive: true });
    expect(own.body.voice).toMatchObject({ mix: priv.recipe, templateId: priv._id, rate: 30 });
  });

  it("作者改（配方重新归一）；非作者 403；删除：点赞一起删，引用它的数字人设置 / 人格只把 templateId 置空、mix 快照保留", async () => {
    const a = await createUser("da");
    const b = await createUser("db");
    const t = await createTemplate(a.token);

    const edit = await request(app)
      .put(`/api/voice-templates/${t._id}`)
      .set(auth(a.token))
      .send({ name: "改名", recipe: [{ voiceId: C, weight: 3 }, { voiceId: M, weight: 1 }], rate: 15, shared: false });
    expect(edit.status).toBe(200);
    expect(edit.body.template).toMatchObject({ name: "改名", rate: 15, shared: false, isOwner: true });
    const mix = [{ voiceId: C, weight: 0.75 }, { voiceId: M, weight: 0.25 }];
    expect(edit.body.template.recipe).toEqual(mix);
    expect(edit.body.template.voice).toMatchObject({ mix, templateId: t._id, rate: 15 });
    expect((await request(app).put(`/api/voice-templates/${t._id}`).set(auth(b.token)).send({ name: "x" })).status).toBe(403);
    const bad = await request(app).put(`/api/voice-templates/${t._id}`).set(auth(a.token)).send({ recipe: [{ voiceId: V2, weight: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/1\.0/);
    await request(app).put(`/api/voice-templates/${t._id}`).set(auth(a.token)).send({ shared: true }).expect(200);

    // b 用它：数字人设置 + 一个人格都从 { templateId } 展开，再点个赞
    const set = await request(app).put("/api/companion/settings").set(auth(b.token)).send({ voice: { templateId: t._id } });
    expect(set.status).toBe(200);
    const snapshot = { voiceId: "", mix, templateId: t._id, rate: 15, pitch: null, instruct: "", expressive: true };
    expect(set.body.settings.voice).toEqual(snapshot);
    const persona = await request(app).post("/api/personas").set(auth(b.token)).send({ name: "用模板的人格", voice: { templateId: t._id } });
    expect(persona.status).toBe(201);
    expect(persona.body.persona.voice).toEqual(snapshot);
    await request(app).post(`/api/voice-templates/${t._id}/like`).set(auth(b.token)).expect(200);

    expect((await request(app).delete(`/api/voice-templates/${t._id}`).set(auth(b.token))).status).toBe(403);
    const del = await request(app).delete(`/api/voice-templates/${t._id}`).set(auth(a.token));
    expect(del.body).toEqual({ ok: true });
    expect((await request(app).get(`/api/voice-templates/${t._id}`).set(auth(a.token))).status).toBe(404);
    const VoiceTemplateLike = require("../src/models/VoiceTemplateLike");
    expect(await VoiceTemplateLike.countDocuments({ template: t._id })).toBe(0);

    const detached = { ...snapshot, templateId: null };
    const after = await request(app).get("/api/companion/settings").set(auth(b.token));
    expect(after.body.settings.voice).toEqual(detached);
    expect(after.body.voice).toEqual(detached);
    const personaAfter = await request(app).get(`/api/personas/${persona.body.persona._id}`).set(auth(b.token));
    expect(personaAfter.body.persona.voice).toEqual(detached);
  });
});
