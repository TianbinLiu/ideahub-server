/**
 * Live2D 模型市场（/api/live2d-models）契约测试：上传解压 + 白名单 + model3.json 校验 + 列表/收藏/点赞/删除。
 * zip 在内存里现做（adm-zip），解压产物落在 uploads/live2d-market/<uid>/，用完删掉。
 */
const fs = require("fs/promises");
const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const AdmZip = require("adm-zip");

let mongod;
let app;
const createdUserIds = new Set();
const MARKET_ROOT = path.join(__dirname, "..", "uploads", "live2d-market");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
});

afterAll(async () => {
  for (const id of createdUserIds) await fs.rm(path.join(MARKET_ROOT, id), { recursive: true, force: true });
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function createUser(prefix = "l2d") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  createdUserIds.add(String(user._id));
  return { user, token: signToken(user) };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * 一个最小但结构完整的 Cubism 4 包：model3.json + moc3 + 贴图 + 表情；可选夹带垃圾/危险文件。
 * refs 盖进 FileReferences、files 多塞几个文件（引用检查那一组用）
 */
function makeBundle({ withEvil = false, cubism2 = false, missingTexture = false, dir = "hiyori", refs = {}, files = {} } = {}) {
  const zip = new AdmZip();
  if (cubism2) {
    zip.addFile(`${dir}/hiyori.model.json`, Buffer.from(JSON.stringify({ model: "hiyori.moc", textures: ["tex.png"] })));
    zip.addFile(`${dir}/hiyori.moc`, Buffer.alloc(64, 1));
    zip.addFile(`${dir}/tex.png`, Buffer.alloc(32, 2));
    return zip.toBuffer();
  }
  const model3 = {
    Version: 3,
    FileReferences: { Moc: "hiyori.moc3", Textures: ["hiyori.4096/texture_00.png"], Expressions: [{ Name: "smile", File: "smile.exp3.json" }], ...refs },
  };
  zip.addFile(`${dir}/hiyori.model3.json`, Buffer.from(JSON.stringify(model3)));
  zip.addFile(`${dir}/hiyori.moc3`, Buffer.concat([Buffer.from("MOC3"), Buffer.alloc(4092, 7)])); // 真 moc3 前 4 字节是 "MOC3"，服务器现在校验
  if (!missingTexture) zip.addFile(`${dir}/hiyori.4096/texture_00.png`, Buffer.alloc(2048, 3));
  zip.addFile(`${dir}/smile.exp3.json`, Buffer.from(JSON.stringify({ Type: "Live2D Expression", Parameters: [] })));
  zip.addFile(`${dir}/readme.txt`, Buffer.from("thanks"));
  if (withEvil) {
    zip.addFile(`${dir}/evil.html`, Buffer.from("<script>alert(1)</script>"));
    zip.addFile(`${dir}/payload.js`, Buffer.from("alert(1)"));
    zip.addFile(`${dir}/logo.svg`, Buffer.from("<svg onload=alert(1)></svg>"));
    zip.addFile("../../escape.png", Buffer.alloc(8, 9));
  }
  for (const [name, data] of Object.entries(files)) zip.addFile(`${dir}/${name}`, data);
  return zip.toBuffer();
}

async function upload(token, { fields = {}, bundle = makeBundle(), filename = "hiyori.zip" } = {}) {
  let req = request(app).post("/api/live2d-models").set(auth(token));
  for (const [k, v] of Object.entries({ name: "测试模型", description: "一个测试包", tags: "测试,可爱", shared: "true", ...fields })) {
    req = req.field(k, String(v));
  }
  return req.attach("bundle", bundle, filename);
}

describe("POST /api/live2d-models", () => {
  it("未登录 401；没带 zip 400", async () => {
    expect((await request(app).post("/api/live2d-models")).status).toBe(401);
    const { token } = await createUser();
    const res = await request(app).post("/api/live2d-models").set(auth(token)).field("name", "x");
    expect(res.status).toBe(400);
  });

  it("上传成功：解压到 uploads/live2d-market/<uid>/，危险文件不落盘，model3.json 可通过 /uploads 访问", async () => {
    const { user, token } = await createUser();
    const res = await upload(token, { bundle: makeBundle({ withEvil: true }), fields: { voice: JSON.stringify({ voiceId: "zh_female_vv_uranus_bigtts", rate: -10 }) } });
    expect(res.status).toBe(201);
    const m = res.body.model;
    expect(m.name).toBe("测试模型");
    expect(m.tags).toEqual(["测试", "可爱"]);
    expect(m.shared).toBe(true);
    expect(m.official).toBe(false);
    expect(m.isOwner).toBe(true);
    expect(m.voice).toEqual({ voiceId: "zh_female_vv_uranus_bigtts", mix: null, templateId: null, rate: -10, pitch: null, instruct: "", expressive: true });
    expect(m.persona).toBeNull();
    expect(m.modelJsonUrl).toMatch(new RegExp(`/uploads/live2d-market/${user._id}/\\d+-hiyori/hiyori/hiyori\\.model3\\.json$`));
    expect(m.fileCount).toBe(6); // model3 + moc3 + png + exp3 + readme.txt + 被剥掉 ../ 前缀后落在包内的 escape.png（白名单内）
    expect(m.bundleBytes).toBeGreaterThan(4096);

    const rel = new URL(m.modelJsonUrl).pathname;
    const served = await request(app).get(rel);
    expect(served.status).toBe(200);
    expect(served.headers["content-security-policy"]).toMatch(/sandbox/);
    const dir = path.join(__dirname, "..", decodeURIComponent(rel).replace(/^\//, "").replace(/\/hiyori\.model3\.json$/, ""));
    const files = await fs.readdir(dir);
    expect(files).toEqual(expect.arrayContaining(["hiyori.model3.json", "hiyori.moc3", "smile.exp3.json", "readme.txt"]));
    expect(files).not.toEqual(expect.arrayContaining(["evil.html"]));
    expect(files).not.toEqual(expect.arrayContaining(["payload.js"]));
    expect(files).not.toEqual(expect.arrayContaining(["logo.svg"]));
    await expect(fs.access(path.join(__dirname, "..", "uploads", "escape.png"))).rejects.toBeTruthy();
  });

  it("Cubism 2 包 / 缺贴图的包 → 400，目录不留", async () => {
    const { user, token } = await createUser();
    const c2 = await upload(token, { bundle: makeBundle({ cubism2: true }) });
    expect(c2.status).toBe(400);
    expect(c2.body.message).toMatch(/Cubism 2/);
    const noTex = await upload(token, { bundle: makeBundle({ missingTexture: true }) });
    expect(noTex.status).toBe(400);
    expect(noTex.body.message).toMatch(/texture/i);
    const userDir = path.join(MARKET_ROOT, String(user._id));
    const left = await fs.readdir(userDir).catch(() => []);
    expect(left).toEqual([]);
  });

  it("绑定人格：公开的可以；别人的私有人格 403；不存在 404", async () => {
    const author = await createUser("pa");
    const other = await createUser("po");
    const shared = await request(app).post("/api/personas").set(auth(other.token)).send({ name: "公开人格", shared: true, style: { summary: "温柔" } });
    const priv = await request(app).post("/api/personas").set(auth(other.token)).send({ name: "私有人格", shared: false });
    expect(shared.status).toBe(201);
    const ok = await upload(author.token, { fields: { personaId: shared.body.persona._id } });
    expect(ok.status).toBe(201);
    expect(ok.body.model.persona).toMatchObject({ _id: shared.body.persona._id, name: "公开人格" });
    expect(ok.body.model.persona.styleDescriptor).toContain("风格：温柔");
    const forbidden = await upload(author.token, { fields: { personaId: priv.body.persona._id } });
    expect(forbidden.status).toBe(403);
    const missing = await upload(author.token, { fields: { personaId: new mongoose.Types.ObjectId().toString() } });
    expect(missing.status).toBe(404);
  });
});

describe("列表 / 详情 / 收藏 / 点赞 / 修改 / 删除", () => {
  it("广场第一页最前面是官方内置条目；私有模型只有作者看得到", async () => {
    const a = await createUser("la");
    const b = await createUser("lb");
    const pub = await upload(a.token, { fields: { name: "公开的" } });
    const priv = await upload(a.token, { fields: { name: "私有的", shared: "false" } });
    expect(pub.status).toBe(201);
    expect(priv.status).toBe(201);

    const list = await request(app).get("/api/live2d-models");
    expect(list.status).toBe(200);
    expect(list.body.models[0]).toMatchObject({ _id: "official-mascot", official: true, modelJsonUrl: "" });
    const names = list.body.models.map((m) => m.name);
    expect(names).toContain("公开的");
    expect(names).not.toContain("私有的");

    const mine = await request(app).get("/api/live2d-models?scope=mine").set(auth(a.token));
    expect(mine.body.models.map((m) => m.name)).toEqual(expect.arrayContaining(["公开的", "私有的"]));
    expect((await request(app).get("/api/live2d-models?scope=mine")).status).toBe(401);

    const detail = await request(app).get(`/api/live2d-models/${priv.body.model._id}`).set(auth(b.token));
    expect(detail.status).toBe(403);
    const own = await request(app).get(`/api/live2d-models/${priv.body.model._id}`).set(auth(a.token));
    expect(own.status).toBe(200);
    expect(own.body.model.stats.viewCount).toBe(1);
    const official = await request(app).get("/api/live2d-models/official-mascot");
    expect(official.body.model.official).toBe(true);

    const q = await request(app).get(`/api/live2d-models?q=${encodeURIComponent("公开")}`);
    expect(q.body.models.map((m) => m.name)).toEqual(["公开的"]); // 有搜索词时不插官方条目
  });

  it("收藏/取消影响 downloadCount 与 scope=installed；点赞开关；官方条目不能收藏", async () => {
    const a = await createUser("ia");
    const b = await createUser("ib");
    const up = await upload(a.token);
    const id = up.body.model._id;

    const inst = await request(app).post(`/api/live2d-models/${id}/install`).set(auth(b.token));
    expect(inst.body).toEqual({ ok: true, installed: true, downloadCount: 1 });
    const again = await request(app).post(`/api/live2d-models/${id}/install`).set(auth(b.token));
    expect(again.body.downloadCount).toBe(1); // 幂等
    const installed = await request(app).get("/api/live2d-models?scope=installed").set(auth(b.token));
    expect(installed.body.models.map((m) => m._id)).toEqual([id]);
    expect(installed.body.models[0].installed).toBe(true);

    const like = await request(app).post(`/api/live2d-models/${id}/like`).set(auth(b.token));
    expect(like.body).toEqual({ ok: true, liked: true, likeCount: 1 });
    const unlike = await request(app).post(`/api/live2d-models/${id}/like`).set(auth(b.token));
    expect(unlike.body).toEqual({ ok: true, liked: false, likeCount: 0 });

    const un = await request(app).delete(`/api/live2d-models/${id}/install`).set(auth(b.token));
    expect(un.body).toEqual({ ok: true, installed: false, downloadCount: 0 });

    expect((await request(app).post("/api/live2d-models/official-mascot/install").set(auth(b.token))).status).toBe(400);
  });

  it("作者改元数据与嗓子；非作者 403；删除连目录一起删并让正在用的用户回到官方", async () => {
    const a = await createUser("da");
    const b = await createUser("db");
    const up = await upload(a.token);
    const id = up.body.model._id;
    const dirRel = decodeURIComponent(new URL(up.body.model.modelJsonUrl).pathname).replace(/^\/uploads\//, "").replace(/\/hiyori\/hiyori\.model3\.json$/, "");
    const dirAbs = path.join(__dirname, "..", "uploads", dirRel);
    await expect(fs.access(dirAbs)).resolves.toBeUndefined();

    const edit = await request(app)
      .put(`/api/live2d-models/${id}`)
      .set(auth(a.token))
      .send({ name: "改名了", voice: { voiceId: "zh_female_gujie_uranus_bigtts", instruct: "慢一点" }, tags: ["新标签"] });
    expect(edit.status).toBe(200);
    expect(edit.body.model.name).toBe("改名了");
    expect(edit.body.model.voice).toMatchObject({ voiceId: "zh_female_gujie_uranus_bigtts", instruct: "慢一点" });
    expect(edit.body.model.tags).toEqual(["新标签"]);
    expect((await request(app).put(`/api/live2d-models/${id}`).set(auth(b.token)).send({ name: "x" })).status).toBe(403);

    // b 把它设为自己的数字人模型
    const setRes = await request(app).put("/api/companion/settings").set(auth(b.token)).send({ modelId: id });
    expect(setRes.status).toBe(200);
    expect(setRes.body.settings.modelId).toBe(id);
    expect(setRes.body.model.name).toBe("改名了");

    expect((await request(app).delete(`/api/live2d-models/${id}`).set(auth(b.token))).status).toBe(403);
    const del = await request(app).delete(`/api/live2d-models/${id}`).set(auth(a.token));
    expect(del.body).toEqual({ ok: true });
    await expect(fs.access(dirAbs)).rejects.toBeTruthy();
    expect((await request(app).get(`/api/live2d-models/${id}`)).status).toBe(404);
    const after = await request(app).get("/api/companion/settings").set(auth(b.token));
    expect(after.body.settings.modelId).toBeNull();
    expect(after.body.model).toBeNull();
  });
});

describe("推荐嗓子来自声音市场的模板", () => {
  const F = "zh_female_gaolengyujie_moon_bigtts";
  const M = "zh_male_shaonianzixin_moon_bigtts";

  it("上传 / 修改时 voice 只给 { templateId }（multipart 里是 JSON 字符串）→ 展开成快照；2.0 混音 400；删模板只摘 templateId", async () => {
    const a = await createUser("va");
    const tpl = await request(app)
      .post("/api/voice-templates")
      .set(auth(a.token))
      .send({ name: "模型配套", recipe: [{ voiceId: F, weight: 1 }, { voiceId: M, weight: 3 }], rate: -5, shared: true });
    expect(tpl.status).toBe(201);
    const templateId = tpl.body.template._id;
    const mix = [{ voiceId: F, weight: 0.25 }, { voiceId: M, weight: 0.75 }];

    const up = await upload(a.token, { fields: { voice: JSON.stringify({ templateId }) } });
    expect(up.status).toBe(201);
    expect(up.body.model.voice).toEqual({ voiceId: "", mix, templateId, rate: -5, pitch: null, instruct: "", expressive: true });

    const bad = await upload(a.token, { fields: { voice: JSON.stringify({ mix: [{ voiceId: "zh_female_vv_uranus_bigtts", weight: 1 }] }) } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/1\.0/);
    const missing = await upload(a.token, { fields: { voice: JSON.stringify({ templateId: new mongoose.Types.ObjectId().toString() }) } });
    expect(missing.status).toBe(404);

    const id = up.body.model._id;
    const edit = await request(app).put(`/api/live2d-models/${id}`).set(auth(a.token)).send({ voice: { templateId, rate: 30 } });
    expect(edit.status).toBe(200);
    expect(edit.body.model.voice).toEqual({ voiceId: "", mix, templateId, rate: 30, pitch: null, instruct: "", expressive: true });

    await request(app).delete(`/api/voice-templates/${templateId}`).set(auth(a.token)).expect(200);
    const after = await request(app).get(`/api/live2d-models/${id}`).set(auth(a.token));
    expect(after.body.model.voice).toEqual({ voiceId: "", mix, templateId: null, rate: 30, pitch: null, instruct: "", expressive: true });
  });
});

// 2026-10-15（owasp-security-6）：App 的 prefetch 与 pixi 舞台拿 model3.json 里每条引用 new URL(ref, base) 去 fetch ——
// 一条外链的动作 / 声音引用 = 装了它的每个人每次开客服页都向那台服务器报到。服务端在入口把引用收口到包内（live2dBundle.service 文件头 ★）
describe("model3.json 的引用只许指向包内", () => {
  const json = (o) => Buffer.from(JSON.stringify(o));
  /** 每一种引用都有、都在包里的一份。声音文件会被扩展名白名单剥掉（.wav 不收），所以对 Sound 服务端只查「指向包内」 */
  const ALL_REFS = {
    Physics: "hiyori.physics3.json",
    Pose: "hiyori.pose3.json",
    DisplayInfo: "hiyori.cdi3.json",
    UserData: "hiyori.userdata3.json",
    Expressions: [{ Name: "smile", File: "smile.exp3.json" }, { Name: "angry", File: "exp/angry.exp3.json" }],
    Motions: {
      Idle: [{ File: "motions/idle.motion3.json", Sound: "sounds/idle.wav" }],
      Tap: [{ File: "motions/tap.motion3.json" }],
    },
  };
  const ALL_FILES = {
    "hiyori.physics3.json": json({ Version: 3, Meta: {}, PhysicsSettings: [] }),
    "hiyori.pose3.json": json({ Type: "Live2D Pose", Groups: [] }),
    "hiyori.cdi3.json": json({ Version: 3, Parameters: [{ Id: "ParamAngleX", Name: "角度 X" }], Parts: [] }),
    "hiyori.userdata3.json": json({ Version: 3, UserData: [] }),
    "exp/angry.exp3.json": json({ Type: "Live2D Expression", Parameters: [] }),
    "motions/idle.motion3.json": json({ Version: 3, Curves: [] }),
    "motions/tap.motion3.json": json({ Version: 3, Curves: [] }),
    "sounds/idle.wav": Buffer.alloc(64, 5),
  };
  const bundleWith = (patch, files = ALL_FILES) => makeBundle({ refs: { ...ALL_REFS, ...patch }, files });
  const without = (files, ...names) => Object.fromEntries(Object.entries(files).filter(([k]) => !names.includes(k)));
  const leftover = (user) => fs.readdir(path.join(MARKET_ROOT, String(user._id))).catch(() => []);

  it("每一种引用都在包里 → 201，能力档案认出物理 / 姿势 / 动作 / 表情 / cdi3；声音文件被白名单剥掉也照收", async () => {
    const { token } = await createUser("rf");
    const res = await upload(token, { bundle: bundleWith({}) });
    expect(res.status).toBe(201);
    expect(res.body.model.capabilities).toMatchObject({ hasPhysics: true, hasPose: true, motionCount: 2, expressions: ["smile", "angry"], paramsKnown: true });
  });

  it.each([
    ["外链的动作文件（https://）", { Motions: { Idle: [{ File: "https://evil.example/track.motion3.json" }] } }, /outside the bundle.*Motions\.Idle\[0\]\.File/],
    ["协议相对的声音（//evil）", { Motions: { Idle: [{ File: "motions/idle.motion3.json", Sound: "//evil.example/ping.wav" }] } }, /outside the bundle.*Motions\.Idle\[0\]\.Sound/],
    ["data: 的 cdi3", { DisplayInfo: "data:application/json,%7B%7D" }, /outside the bundle.*DisplayInfo/],
    ["../ 出包的物理文件", { Physics: "../outside.physics3.json" }, /outside the bundle.*Physics/],
    ["绝对路径的姿势文件", { Pose: "/etc/pose3.json" }, /outside the bundle.*Pose/],
    ["反斜杠开头的用户数据（UNC）", { UserData: "\\\\evil\\share\\x.userdata3.json" }, /outside the bundle.*UserData/],
    ["外链的表情文件", { Expressions: [{ Name: "x", File: "http://evil.example/x.exp3.json" }] }, /outside the bundle.*Expressions\[0\]\.File/],
  ])("%s → 400 并点名，目录不留", async (_label, patch, re) => {
    const { user, token } = await createUser("rx");
    const res = await upload(token, { bundle: bundleWith(patch) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(await leftover(user)).toEqual([]);
  });

  it.each([
    ["物理", ["hiyori.physics3.json"], /missing.*Physics/],
    ["动作", ["motions/tap.motion3.json"], /missing.*Motions\.Tap\[0\]\.File/],
    ["表情", ["exp/angry.exp3.json"], /missing.*Expressions\[1\]\.File/],
  ])("引用了包里没有的%s文件 → 400 并点名（坏包，与缺贴图同一口径）", async (_label, missing, re) => {
    const { user, token } = await createUser("rm");
    const res = await upload(token, { bundle: bundleWith({}, without(ALL_FILES, ...missing)) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(re);
    expect(await leftover(user)).toEqual([]);
  });
});
