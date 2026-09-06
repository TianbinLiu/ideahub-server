/**
 * 创作中心 · 人物模型（2026-09-05）：能力档案提取 + companion.json 映射（自动 / 校验 / 落盘）+ /inspect + 下架过滤。
 * zip 在内存里现做（adm-zip）；解压产物落在 uploads/live2d-market/<uid>/ 与 uploads/tmp-inspect/，用完删掉。
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
const TMP_ROOT = path.join(__dirname, "..", "uploads", "tmp-inspect");

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

async function createUser(prefix = "cap") {
  const User = require("../src/models/User");
  const { signToken } = require("../src/utils/jwt");
  const random = new mongoose.Types.ObjectId().toString().slice(-6);
  const user = await User.create({ username: `${prefix}_${random}`, email: `${random}@test.local`, role: "user", passwordHash: "hashed" });
  createdUserIds.add(String(user._id));
  return { user, token: signToken(user) };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** 1×1 PNG 头（只要 IHDR 宽高对就行，服务器只读文件头） */
function pngHeader(width, height) {
  const b = Buffer.alloc(64, 0);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** nizima 风格的包：Idle / Start / Tap@Head / Tap@Body / nod / wave 动作组，Smile / Angry / Blushing 表情，Head / Body 命中区，cdi3 带参数 */
function makeNizimaBundle({ dir = "mika", texSide = 2048, withCdi = true, twoModels = false } = {}) {
  const zip = new AdmZip();
  const motion = { Version: 3, Meta: { Duration: 1, Fps: 30, Loop: false, CurveCount: 0, TotalSegmentCount: 0, TotalPointCount: 0 }, Curves: [] };
  const groups = { Idle: ["idle_a", "idle_b"], Start: ["start"], "Tap@Head": ["tap_head"], "Tap@Body": ["tap_body"], nod: ["nod"], wave: ["wave"] };
  const Motions = {};
  for (const [g, files] of Object.entries(groups)) {
    Motions[g] = files.map((f) => ({ File: `motions/${f}.motion3.json` }));
    for (const f of files) zip.addFile(`${dir}/motions/${f}.motion3.json`, Buffer.from(JSON.stringify(motion)));
  }
  const Expressions = ["Smile", "Angry", "Blushing"].map((n) => ({ Name: n, File: `expressions/${n}.exp3.json` }));
  for (const e of Expressions) zip.addFile(`${dir}/${e.File}`, Buffer.from(JSON.stringify({ Type: "Live2D Expression", Parameters: [] })));
  const model3 = {
    Version: 3,
    FileReferences: {
      Moc: "mika.moc3",
      Textures: ["mika.2048/texture_00.png"],
      Physics: "mika.physics3.json",
      Motions,
      Expressions,
      ...(withCdi ? { DisplayInfo: "mika.cdi3.json" } : {}),
    },
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: ["PARAM_EYE_L_OPEN", "PARAM_EYE_R_OPEN"] },
      { Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] },
    ],
    HitAreas: [{ Id: "HitAreaHead", Name: "Head" }, { Id: "HitAreaBody", Name: "Body" }],
  };
  zip.addFile(`${dir}/mika.model3.json`, Buffer.from(JSON.stringify(model3)));
  zip.addFile(`${dir}/mika.moc3`, Buffer.concat([Buffer.from("MOC3"), Buffer.alloc(1020, 1)]));
  zip.addFile(`${dir}/mika.2048/texture_00.png`, pngHeader(texSide, texSide));
  zip.addFile(`${dir}/mika.physics3.json`, Buffer.from(JSON.stringify({ Version: 3, Meta: { PhysicsSettingCount: 0 }, PhysicsSettings: [] })));
  if (withCdi) {
    const ids = ["PARAM_ANGLE_X", "ParamAngleY", "ParamAngleZ", "PARAM_EYE_L_OPEN", "PARAM_EYE_R_OPEN", "ParamMouthOpenY", "ParamBodyAngleX", "ParamBreath"];
    zip.addFile(`${dir}/mika.cdi3.json`, Buffer.from(JSON.stringify({ Version: 3, Parameters: ids.map((Id) => ({ Id, GroupId: "", Name: Id })), ParameterGroups: [], Parts: [] })));
  }
  if (twoModels) {
    zip.addFile(`${dir}/alt/alt.model3.json`, Buffer.from(JSON.stringify({ Version: 3, FileReferences: { Moc: "alt.moc3", Textures: ["alt.png"] } })));
    zip.addFile(`${dir}/alt/alt.moc3`, Buffer.concat([Buffer.from("MOC3"), Buffer.alloc(100, 2)]));
    zip.addFile(`${dir}/alt/alt.png`, pngHeader(512, 512));
  }
  return zip.toBuffer();
}

async function upload(token, { fields = {}, bundle = makeNizimaBundle(), filename = "mika.zip" } = {}) {
  let req = request(app).post("/api/live2d-models").set(auth(token));
  for (const [k, v] of Object.entries({ name: "米卡", description: "nizima 风格测试包", tags: "测试", shared: "true", selfMade: "true", ...fields })) {
    req = req.field(k, String(v));
  }
  return req.attach("bundle", bundle, filename);
}

describe("live2dCapabilities.service（纯函数）", () => {
  const caps = require("../src/services/live2dCapabilities.service");

  it("suggestMapping：nizima 名 / 官方组名 / 旧式参数 id 都能自动对上，对不上的是 null", () => {
    const m = caps.suggestMapping({
      motionGroups: ["Idle", "Start", "Tap@Head", "Flick@Body", "nod", "wave", "TapBody"],
      expressions: ["Smile", "Angry", "Blushing", "F04"],
      hitAreas: ["Head", "Body", "Hair"],
      params: ["PARAM_ANGLE_X", "ParamAngleY", "ParamMouthOpenY", "PARAM_EYE_L_OPEN", "ParamEyeROpen"],
      paramsKnown: true,
    });
    expect(m.idle).toBe("Idle");
    expect(m.start).toBe("Start");
    expect(m.actions.acknowledge).toBe("nod");
    expect(m.actions.explain).toBe("nod");
    expect(m.actions.wave).toBe("wave");
    expect(m.actions.think).toBeNull();
    expect(m.faces.happy).toEqual({ expression: "Smile" });
    expect(m.faces.angry).toEqual({ expression: "Angry" });
    expect(m.faces.shy).toEqual({ expression: "Blushing" });
    expect(m.faces.crying).toBeNull();
    expect(m.touch.Head).toEqual({ hitAreas: ["Head"], motion: "Tap@Head" });
    expect(m.touch.Body).toEqual({ hitAreas: ["Body"], motion: "TapBody" }); // tap 优先于 flick；只做全名匹配
    expect(m.touch.Hair).toEqual({ hitAreas: ["Hair"], motion: null });
    expect(m.touch.Skirt).toBeNull();
    expect(m.params.angleX).toBe("PARAM_ANGLE_X");
    expect(m.params.eyeL).toBe("PARAM_EYE_L_OPEN");
    expect(m.params.mouthOpen).toBe("ParamMouthOpenY");
    expect(m.params.cheek).toBeNull();
    // 没有 cdi3（params 为空）→ 假定标准 id
    expect(caps.suggestMapping({ motionGroups: [], expressions: [], hitAreas: [], params: [] }).params.angleX).toBe("ParamAngleX");
  });

  it("validateMapping：未知槽位 / 引用包里没有的动作组、表情、命中区 → 400；合法的归一出全部槽位", () => {
    const c = { motionGroups: ["Idle", "wave"], expressions: ["Smile"], hitAreas: ["Head"], params: ["ParamAngleX"], paramsKnown: true };
    expect(() => caps.validateMapping({ actions: { dance: "wave" } }, c)).toThrow(/unknown action slot/);
    expect(() => caps.validateMapping({ actions: { wave: "nope" } }, c)).toThrow(/motion group "nope"/);
    expect(() => caps.validateMapping({ faces: { happy: { expression: "Grin" } } }, c)).toThrow(/expression "Grin"/);
    expect(() => caps.validateMapping({ touch: { Head: { hitAreas: ["Face"] } } }, c)).toThrow(/hit area "Face"/);
    expect(() => caps.validateMapping({ idle: 42 }, c)).toThrow(/invalid/);
    const { mapping, warnings } = caps.validateMapping(
      { idle: "Idle", actions: { wave: "wave" }, faces: { happy: { expression: "Smile" }, sad: { params: { ParamBrowLY: -0.5 } } }, touch: { Head: { hitAreas: ["Head"], motion: "wave" } }, params: { angleX: "PARAM_ANGLE_X" } },
      c
    );
    expect(mapping.actions.wave).toBe("wave");
    expect(mapping.actions.shy).toBeNull();
    expect(mapping.faces.happy).toEqual({ expression: "Smile" });
    expect(mapping.faces.sad).toEqual({ params: { ParamBrowLY: -0.5 } });
    expect(mapping.faces.angry).toBeNull();
    expect(mapping.touch.Head).toEqual({ hitAreas: ["Head"], motion: "wave" });
    expect(mapping.params.mouthOpen).toBe("ParamMouthOpenY"); // 没给的槽位回标准 id
    expect(warnings.some((w) => w.includes("PARAM_ANGLE_X"))).toBe(true); // cdi3 里没有这个 id → 只警告
  });

  it("imageSizeFromBuffer：PNG / WebP(VP8X) / JPEG 头都能读出宽高，垃圾数据回 null", () => {
    expect(caps.imageSizeFromBuffer(pngHeader(4096, 2048))).toEqual({ width: 4096, height: 2048 });
    const webp = Buffer.alloc(40, 0);
    webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1023, 24, 3); webp.writeUIntLE(767, 27, 3);
    expect(caps.imageSizeFromBuffer(webp)).toEqual({ width: 1024, height: 768 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x03, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    expect(caps.imageSizeFromBuffer(jpg)).toEqual({ width: 768, height: 512 });
    expect(caps.imageSizeFromBuffer(Buffer.alloc(100, 3))).toBeNull();
  });
});

describe("POST /api/live2d-models/inspect", () => {
  it("未登录 401；没带 zip 400；正常包回 能力档案 + 自动映射 + 完成度 + 入口候选，临时目录删干净", async () => {
    const { token } = await createUser();
    expect((await request(app).post("/api/live2d-models/inspect")).status).toBe(401);
    expect((await request(app).post("/api/live2d-models/inspect").set(auth(token))).status).toBe(400);
    const res = await request(app).post("/api/live2d-models/inspect").set(auth(token)).attach("bundle", makeNizimaBundle({ twoModels: true }), "mika.zip");
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual(["mika/alt/alt.model3.json", "mika/mika.model3.json"]);
    expect(res.body.entry).toBe("mika/alt/alt.model3.json"); // 没指定 → 按名字排序第一个
    const picked = await request(app).post("/api/live2d-models/inspect").set(auth(token)).field("entry", "mika/mika.model3.json").attach("bundle", makeNizimaBundle({ twoModels: true }), "mika.zip");
    expect(picked.status).toBe(200);
    expect(picked.body.entry).toBe("mika/mika.model3.json");
    const c = picked.body.capabilities;
    expect(c.motionGroups).toEqual(expect.arrayContaining(["Idle", "Start", "Tap@Head", "Tap@Body", "nod", "wave"]));
    expect(c.motionCount).toBe(7);
    expect(c.expressions).toEqual(["Smile", "Angry", "Blushing"]);
    expect(c.hitAreas).toEqual(["Head", "Body"]);
    expect(c.paramsKnown).toBe(true);
    expect(c.params).toEqual(expect.arrayContaining(["PARAM_ANGLE_X", "ParamMouthOpenY", "PARAM_EYE_L_OPEN"]));
    expect(c.hasPhysics).toBe(true);
    expect(c.textures).toEqual({ count: 1, maxSide: 2048 });
    expect(c.badges).toEqual(["motions", "expressions", "touch", "physics"]);
    expect(picked.body.mapping.touch.Head).toEqual({ hitAreas: ["Head"], motion: "Tap@Head" });
    expect(picked.body.mapping.params.angleX).toBe("PARAM_ANGLE_X");
    expect(picked.body.completeness.required.every((r) => r.ok === true)).toBe(true);
    expect(picked.body.completeness.recommendedDone).toBeGreaterThan(5);
    expect(picked.body.warnings).toEqual([]);
    const left = await fs.readdir(TMP_ROOT).catch(() => []);
    expect(left).toEqual([]);
  });

  it("贴图超 4096 / 没有 Idle 只是 warning；坏 moc3 头 400", async () => {
    const { token } = await createUser();
    const big = await request(app).post("/api/live2d-models/inspect").set(auth(token)).attach("bundle", makeNizimaBundle({ texSide: 8192 }), "mika.zip");
    expect(big.status).toBe(200);
    expect(big.body.warnings.join(" ")).toMatch(/4096/);
    const zip = new AdmZip();
    zip.addFile("x/x.model3.json", Buffer.from(JSON.stringify({ Version: 3, FileReferences: { Moc: "x.moc3", Textures: ["x.png"] } })));
    zip.addFile("x/x.moc3", Buffer.alloc(64, 7));
    zip.addFile("x/x.png", pngHeader(64, 64));
    const bad = await request(app).post("/api/live2d-models/inspect").set(auth(token)).attach("bundle", zip.toBuffer(), "x.zip");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/MOC3/);
  });
});

describe("POST /api/live2d-models 带映射", () => {
  it("没给 mapping → 自动映射并写 companion.json（可通过 /uploads 读到）；payload 带 capabilities / mapping / license", async () => {
    const { token } = await createUser();
    const res = await upload(token);
    expect(res.status).toBe(201);
    const m = res.body.model;
    expect(m.capabilities.badges).toEqual(["motions", "expressions", "touch", "physics"]);
    expect(m.mapping.idle).toBe("Idle");
    expect(m.mapping.faces.happy).toEqual({ expression: "Smile" });
    expect(m.license.selfMade).toBe(true);
    expect(m.license.agreedAt).toBeTruthy();
    expect(m.takenDown).toBe(false);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.entries).toEqual(["mika/mika.model3.json"]);
    const companionUrl = new URL("companion.json", m.modelJsonUrl);
    const served = await request(app).get(companionUrl.pathname);
    expect(served.status).toBe(200);
    expect(JSON.parse(served.text).touch.Head).toEqual({ hitAreas: ["Head"], motion: "Tap@Head" });
  });

  it("mapping 引用了包里没有的东西 → 400，目录不留；合法 mapping 原样落盘；PUT mapping=null 恢复自动映射", async () => {
    const { user, token } = await createUser();
    const bad = await upload(token, { fields: { mapping: JSON.stringify({ actions: { wave: "Dance" } }) } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Dance/);
    expect(await fs.readdir(path.join(MARKET_ROOT, String(user._id))).catch(() => [])).toEqual([]);
    const notJson = await upload(token, { fields: { mapping: "{oops" } });
    expect(notJson.status).toBe(400);

    const custom = { idle: "Idle", actions: { wave: "wave", surprised: "Tap@Head" }, faces: { happy: { expression: "Smile" } }, touch: { Head: { hitAreas: ["Head"], motion: "Tap@Head" } } };
    const ok = await upload(token, { fields: { mapping: JSON.stringify(custom) } });
    expect(ok.status).toBe(201);
    expect(ok.body.model.mapping.actions.surprised).toBe("Tap@Head");
    expect(ok.body.model.mapping.faces.shy).toBeNull(); // 用户没映射的槽位是 null，不会偷偷自动补
    const id = ok.body.model._id;

    const put = await request(app).put(`/api/live2d-models/${id}`).set(auth(token)).send({ mapping: { actions: { wave: "nope" } } });
    expect(put.status).toBe(400);
    const reset = await request(app).put(`/api/live2d-models/${id}`).set(auth(token)).send({ mapping: null });
    expect(reset.status).toBe(200);
    expect(reset.body.model.mapping.faces.shy).toEqual({ expression: "Blushing" }); // 自动映射回来了
    const served = await request(app).get(new URL("companion.json", reset.body.model.modelJsonUrl).pathname);
    expect(JSON.parse(served.text).faces.shy).toEqual({ expression: "Blushing" });
  });

  it("下架（takenDown）：市场不列、他人详情 404、作者 scope=mine 仍可见且带标记", async () => {
    const author = await createUser("ta");
    const other = await createUser("to");
    const created = await upload(author.token, { fields: { name: "要下架的" } });
    expect(created.status).toBe(201);
    const id = created.body.model._id;
    const Live2dModel = require("../src/models/Live2dModel");
    await Live2dModel.updateOne({ _id: id }, { $set: { takenDown: true } });

    const list = await request(app).get("/api/live2d-models").set(auth(other.token));
    expect(list.body.models.map((x) => x._id)).not.toContain(id);
    expect((await request(app).get(`/api/live2d-models/${id}`).set(auth(other.token))).status).toBe(404);
    const mine = await request(app).get("/api/live2d-models?scope=mine").set(auth(author.token));
    const row = mine.body.models.find((x) => x._id === id);
    expect(row).toBeTruthy();
    expect(row.takenDown).toBe(true);
    // 正在用它的用户被退回官方：loadUsableModel 对下架回 null
    const { loadUsableModel } = require("../src/services/live2dMarket.service");
    expect(await loadUsableModel(id, author.user._id)).toBeNull();
  });
});
