// tests/branchTemplate.spec.js
// 覆盖：白模模板（/api/branch/templates）与模板视频上传（/api/uploads/template-video）。
//
// ★ 这些闸门的共同点是「拆掉也不报错」，所以逐条从行为上钉住：
//   ① videoUrl 三重白名单（host + 目录 + 归属）—— 松一道就能把别人的/别处的资源注册成模板
//   ② 元数据只由服务端从 Cloudinary 写入 —— 客户端塞什么都进不来（zod strip 是帮手不是漏洞）
//   ③ 试炼闸（provenAt 非空才许发布）—— 坏模板的学费必须由作者自己付
//   ④ shared 只出 published —— pending/blocked 漏出去就是市场上摆着不能用/被下架的货
//   ⑤ DELETE 连带 uploader.destroy —— 不回收就是配额只增不减
//
// ★ Cloudinary 全程是假的（jest.spyOn），不出网也不需要配置。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let cloudinary;
let owner; // { token, id }
let other; // { token, id }
let resourceSpy;
let destroySpy;

const CLOUD_PREFIX = "https://res.cloudinary.com/demo/video/upload/v1712000000";

/** 上传后拿到的那种 URL（public_id = `${userId}-${ts}`，与 uploads.routes 的生成规则一致） */
function videoUrlOf(userId, ts) {
  return `${CLOUD_PREFIX}/ideahub/template-videos/${userId}-${ts}.mp4`;
}

/** Cloudinary 资源详情的假回执（服务端登记元数据的唯一来源） */
function fakeResource(publicId, over = {}) {
  return {
    public_id: publicId,
    secure_url: `${CLOUD_PREFIX}/${publicId}.mp4`,
    duration: 10,
    width: 720,
    height: 1280,
    bytes: 5_000_000,
    ...over,
  };
}

async function registerUser(tag) {
  const name = `tpl_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, id: res.body.user._id };
}

function validBody(videoUrl, over = {}) {
  return {
    title: "白模跑酷",
    intro: "一段测试模板",
    coverUrl: "",
    recipe: { styleHint: "赛博都市", beats: ["主角穿过巷子"], durationSec: 10, videoTier: "ultra", aspect: "portrait", framePrompt: "俯拍" },
    videoUrl,
    ...over,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  ({ cloudinary } = require("../src/config/cloudinary"));

  owner = await registerUser("owner");
  other = await registerUser("other");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(() => {
  // 资源详情：按传入的 public_id 回一份合格回执（单条用例里再按需覆写）
  resourceSpy = jest
    .spyOn(cloudinary.api, "resource")
    .mockImplementation(async (publicId) => fakeResource(publicId));
  destroySpy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
});

afterEach(() => {
  resourceSpy.mockRestore();
  destroySpy.mockRestore();
});

const asOwner = () => ({ Authorization: `Bearer ${owner.token}` });
const asOther = () => ({ Authorization: `Bearer ${other.token}` });

async function createTemplate(ts, over = {}) {
  const res = await request(app)
    .post("/api/branch/templates")
    .set(asOwner())
    .send(validBody(videoUrlOf(owner.id, ts), over));
  expect(res.status).toBe(201);
  return res.body.template;
}

// ─────────────────────────────────────────────────────────────────────
describe("videoUrl 三重白名单（host + 目录 + 归属）", () => {
  const cases = () => [
    ["别的域名", `https://evil.example.com/ideahub/template-videos/${owner.id}-1.mp4`],
    ["host 只是像（前缀）", `https://res.cloudinary.com.evil.example/ideahub/template-videos/${owner.id}-1.mp4`],
    ["明文 http", `http://res.cloudinary.com/demo/video/upload/v1/ideahub/template-videos/${owner.id}-1.mp4`],
    ["别的目录（/media 传的）", `${CLOUD_PREFIX}/ideahub/workshop-media/${owner.id}-1.mp4`],
    ["目录后多一层路径", `${CLOUD_PREFIX}/ideahub/template-videos/evil/${owner.id}-1.mp4`],
    ["别人的 public_id", `${CLOUD_PREFIX}/ideahub/template-videos/${other.id}-1.mp4`],
    ["public_id 形状不对", `${CLOUD_PREFIX}/ideahub/template-videos/${owner.id}-abc.mp4`],
  ];

  test.each([0, 1, 2, 3, 4, 5, 6])("第 %i 条不合格地址 → 400，且不去 Cloudinary 查", async (i) => {
    const [, url] = cases()[i];
    const res = await request(app).post("/api/branch/templates").set(asOwner()).send(validBody(url));
    expect(res.status).toBe(400);
    // 白名单挡在出网之前：不合格的地址连资源详情都不该去查
    expect(resourceSpy).not.toHaveBeenCalled();
  });

  test("合格地址 → 201，且登记的是 Cloudinary 的规范 url + 服务端取的元数据", async () => {
    const tpl = await createTemplate(2001);
    expect(tpl.status).toBe("pending");
    expect(tpl.provenAt).toBeNull();
    // 元数据来自假回执（duration 10 / 720×1280），不是客户端能给的
    expect(tpl.refVideo).toMatchObject({ durationSec: 10, width: 720, height: 1280, bytes: 5_000_000 });
    expect(tpl.refVideo.url).toBe(`${CLOUD_PREFIX}/ideahub/template-videos/${owner.id}-2001.mp4`);
    expect(resourceSpy).toHaveBeenCalledWith(`ideahub/template-videos/${owner.id}-2001`, { resource_type: "video" });
  });

  test("同一段视频不能登记两个模板（unique 索引 → 409 整句）", async () => {
    await createTemplate(2002);
    const res = await request(app)
      .post("/api/branch/templates")
      .set(asOwner())
      .send(validBody(videoUrlOf(owner.id, 2002)));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/登记过/);
  });

  test("Cloudinary 查无此资源（已被回收/编造的地址）→ 400 整句", async () => {
    resourceSpy.mockRejectedValue({ error: { http_code: 404, message: "not found" } });
    const res = await request(app)
      .post("/api/branch/templates")
      .set(asOwner())
      .send(validBody(videoUrlOf(owner.id, 2003)));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/重新上传/);
  });

  test("资源存在但不过验收窗口（30s 长片）→ 400 整句（与上传复核同一份规则）", async () => {
    resourceSpy.mockImplementation(async (publicId) => fakeResource(publicId, { duration: 30 }));
    const res = await request(app)
      .post("/api/branch/templates")
      .set(asOwner())
      .send(validBody(videoUrlOf(owner.id, 2004)));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/最长 15 秒/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("zod strip 回归：未声明字段发得出、存不下，敏感字段改不动", () => {
  test("客户端塞 status/provenAt/refVideo/ownerId → 全部被剥掉，服务端的值说了算", async () => {
    const res = await request(app)
      .post("/api/branch/templates")
      .set(asOwner())
      .send(
        validBody(videoUrlOf(owner.id, 3001), {
          // 这些都是「发得出」的：一个都不许「存得下」
          status: "published",
          provenAt: new Date().toISOString(),
          ownerId: other.id,
          authorName: "假冒者",
          refVideo: { durationSec: 1, width: 1, height: 1, bytes: 0, url: "https://evil.example.com/x.mp4" },
        })
      );
    expect(res.status).toBe(201);

    // 读回来必须是服务端写的那份（不是回显请求体 —— 读的是库）
    const back = await request(app).get(`/api/branch/templates/${res.body.template.id}`).set(asOwner());
    expect(back.status).toBe(200);
    const tpl = back.body.template;
    expect(tpl.status).toBe("pending"); // 不是 "published"
    expect(tpl.provenAt).toBeNull();
    expect(tpl.ownerId).toBe(String(owner.id)); // 不是 other
    expect(tpl.refVideo.durationSec).toBe(10); // Cloudinary 的数，不是客户端报的 1
    expect(tpl.refVideo.url).toContain("res.cloudinary.com");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("试炼闸与发布状态机", () => {
  const BranchTemplate = () => require("../src/models/BranchTemplate");

  test("provenAt 为空 → 发布 400 整句；置上（模拟试炼通过）→ 发布成功", async () => {
    const tpl = await createTemplate(4001);

    const denied = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(denied.status).toBe(400);
    expect(typeof denied.body.message).toBe("string");
    expect(denied.body.message).toMatch(/出一段片|出片/);

    // 试炼通过的唯一写入方是服务端的 r2v 追踪（arkProxy.spec 钉了那条链），
    // 这里直接落库模拟那个结果，测的是发布闸本身
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date() } });
    const ok = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(ok.status).toBe(200);
    expect(ok.body.template.status).toBe("published");
  });

  test("非作者不能 publish / unpublish / delete（403，身份只认 ownerId）", async () => {
    const tpl = await createTemplate(4002);
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date() } });

    expect((await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOther())).status).toBe(403);
    expect((await request(app).patch(`/api/branch/templates/${tpl.id}/unpublish`).set(asOther())).status).toBe(403);
    const del = await request(app).delete(`/api/branch/templates/${tpl.id}`).set(asOther());
    expect(del.status).toBe(403);
    expect(destroySpy).not.toHaveBeenCalled(); // 拒了就不许碰云端资产
    expect(await BranchTemplate().findById(tpl.id).lean()).toBeTruthy();
  });

  test("shared 只出 published：pending/blocked/unpublish 后的都不出", async () => {
    const a = await createTemplate(4003); // 将发布
    const b = await createTemplate(4004); // 保持 pending
    const c = await createTemplate(4005); // 将 blocked
    await BranchTemplate().updateOne({ _id: a.id }, { $set: { provenAt: new Date() } });
    await request(app).patch(`/api/branch/templates/${a.id}/publish`).set(asOwner()).expect(200);
    await BranchTemplate().updateOne({ _id: c.id }, { $set: { status: "blocked" } });

    // 匿名逛市场（optionalAuth）
    const list = await request(app).get("/api/branch/templates/shared");
    expect(list.status).toBe(200);
    const ids = list.body.templates.map((t) => t.id);
    expect(ids).toContain(String(a.id));
    expect(ids).not.toContain(String(b.id));
    expect(ids).not.toContain(String(c.id));

    // 下架后从市场消失
    await request(app).patch(`/api/branch/templates/${a.id}/unpublish`).set(asOwner()).expect(200);
    const after = await request(app).get("/api/branch/templates/shared");
    expect(after.body.templates.map((t) => t.id)).not.toContain(String(a.id));
  });

  test("pending 详情：作者可见，别人 404（不泄露存在性）", async () => {
    const tpl = await createTemplate(4006);
    expect((await request(app).get(`/api/branch/templates/${tpl.id}`).set(asOwner())).status).toBe(200);
    expect((await request(app).get(`/api/branch/templates/${tpl.id}`).set(asOther())).status).toBe(404);
    expect((await request(app).get(`/api/branch/templates/${tpl.id}`)).status).toBe(404); // 匿名同样
  });

  test("blocked 后作者既不能 publish 也不能借 unpublish 洗回 pending", async () => {
    const tpl = await createTemplate(4007);
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date(), status: "blocked" } });
    expect((await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner())).status).toBe(400);
    expect((await request(app).patch(`/api/branch/templates/${tpl.id}/unpublish`).set(asOwner())).status).toBe(400);
    const still = await BranchTemplate().findById(tpl.id).lean();
    expect(still.status).toBe("blocked");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("DELETE 连带回收云端资产（全仓第一个 uploader.destroy 的行为钉子）", () => {
  const BranchTemplate = () => require("../src/models/BranchTemplate");

  test("删除成功：destroy 按登记的 public_id + resource_type video 被调，记录删掉", async () => {
    const tpl = await createTemplate(5001);
    const res = await request(app).delete(`/api/branch/templates/${tpl.id}`).set(asOwner());
    expect(res.status).toBe(200);
    expect(destroySpy).toHaveBeenCalledWith(`ideahub/template-videos/${owner.id}-5001`, { resource_type: "video" });
    expect(await BranchTemplate().findById(tpl.id).lean()).toBeNull();
  });

  test("云端回收失败 → 502、模板保留（先云端后库：不留永久孤儿资产）", async () => {
    const tpl = await createTemplate(5002);
    destroySpy.mockRejectedValue({ error: { message: "cloudinary down" } });
    const res = await request(app).delete(`/api/branch/templates/${tpl.id}`).set(asOwner());
    expect(res.status).toBe(502);
    // 库里还在：用户重试一次即可（destroy 幂等），资产不会变成找不回 public_id 的孤儿
    expect(await BranchTemplate().findById(tpl.id).lean()).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("DELETE /api/uploads/template-video：未登记孤儿视频的回收", () => {
  // ★ 为什么有这一组：上传成功但从未登记成模板的视频（视觉分析挂了/用户放弃），
  //   此前两处 destroy 都够不着 —— 客户端靠这个端点兜底，否则配额只增不减零症状。
  test("本账号未登记的 publicId → destroy 被调、200", async () => {
    const publicId = `ideahub/template-videos/${owner.id}-9001`;
    const res = await request(app).delete("/api/uploads/template-video").set(asOwner()).send({ publicId });
    expect(res.status).toBe(200);
    expect(destroySpy).toHaveBeenCalledWith(publicId, { resource_type: "video" });
  });

  test("别人的 publicId → 400，云端资产不被碰（归属钉在前缀上）", async () => {
    const publicId = `ideahub/template-videos/${owner.id}-9002`;
    const res = await request(app).delete("/api/uploads/template-video").set(asOther()).send({ publicId });
    expect(res.status).toBe(400);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  test("已登记为模板的 publicId → 400（生命周期归 DELETE 模板级联管，不许从侧门抽底）", async () => {
    const tpl = await createTemplate(9003);
    const res = await request(app)
      .delete("/api/uploads/template-video")
      .set(asOwner())
      .send({ publicId: `ideahub/template-videos/${owner.id}-9003` });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/删除模板/);
    expect(destroySpy).not.toHaveBeenCalled();
    // 模板本体不受影响
    expect(await require("../src/models/BranchTemplate").findById(tpl.id).lean()).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("POST /api/uploads/template-video：回执复核 + 不合格先 destroy 再 400", () => {
  let uploadStreamSpy;

  /** 把 upload_stream 换成假的：立即用给定回执回调 */
  function mockUploadReceipt(over = {}) {
    uploadStreamSpy = jest.spyOn(cloudinary.uploader, "upload_stream").mockImplementation((opts, cb) => ({
      end: () => cb(null, fakeResource(`${opts.folder}/${opts.public_id}`, over)),
    }));
  }

  afterEach(() => {
    if (uploadStreamSpy) uploadStreamSpy.mockRestore();
    uploadStreamSpy = null;
  });

  test("合格视频 → 200，回执元数据随响应返回", async () => {
    mockUploadReceipt();
    const res = await request(app)
      .post("/api/uploads/template-video")
      .set(asOwner())
      .attach("video", Buffer.from("fake-mp4"), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duration: 10, width: 720, height: 1280, bytes: 5_000_000 });
    expect(res.body.url).toContain("/ideahub/template-videos/");
    expect(res.body.publicId).toContain(`${owner.id}-`);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  test.each([
    ["太短（3s）", { duration: 3 }, /至少要 4 秒/],
    ["太长（20s）", { duration: 20 }, /最长 15 秒/],
    ["像素数不够（640×360）", { width: 640, height: 360 }, /分辨率太低/],
    ["比例过细长（500×1500）", { width: 500, height: 1500 }, /宽高比/],
  ])("回执复核不过：%s → 先 destroy 再 400 整句", async (_label, over, msgRe) => {
    mockUploadReceipt(over);
    const res = await request(app)
      .post("/api/uploads/template-video")
      .set(asOwner())
      .attach("video", Buffer.from("fake-mp4"), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msgRe); // 整句中文原因，不是错误码天书
    expect(destroySpy).toHaveBeenCalledTimes(1); // 不合格的上传不许占配额
    expect(destroySpy.mock.calls[0][1]).toEqual({ resource_type: "video" });
  });

  test("webm 直接 400（r2v 只认 mp4/mov，/media 的白名单不适用）", async () => {
    mockUploadReceipt();
    const res = await request(app)
      .post("/api/uploads/template-video")
      .set(asOwner())
      .attach("video", Buffer.from("fake-webm"), { filename: "a.webm", contentType: "video/webm" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mp4/);
    expect(uploadStreamSpy).not.toHaveBeenCalled(); // 挡在上传之前，不出网
  });

  test("未登录 → 401（每一发都是 20MB 级出网 + 永久配额，不许裸奔）", async () => {
    const res = await request(app)
      .post("/api/uploads/template-video")
      .attach("video", Buffer.from("x"), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("templateVideoIssue：验收窗口的唯一实现（单元）", () => {
  const { templateVideoIssue, TEMPLATE_VIDEO_RULES } = require("../src/middleware/upload");

  test("合格样本 → null", () => {
    expect(templateVideoIssue({ duration: 10, width: 720, height: 1280 })).toBeNull();
    expect(templateVideoIssue({ duration: 4, width: 640, height: 640 })).toBeNull(); // 409,600 ≥ 407,696
  });

  test("像素数硬门是 407,696（A2 探针实测值，改它必须两仓一起改）", () => {
    expect(TEMPLATE_VIDEO_RULES.minPixels).toBe(407_696);
    // 640×636 = 407,040 < 门；640×640 = 409,600 ≥ 门
    expect(templateVideoIssue({ duration: 10, width: 640, height: 636 })).toMatch(/分辨率太低/);
    expect(templateVideoIssue({ duration: 10, width: 640, height: 640 })).toBeNull();
  });

  test("缺元数据（回执没给 duration）→ 整句拒，不放行", () => {
    expect(templateVideoIssue({ width: 720, height: 1280 })).toMatch(/无法登记/);
    expect(templateVideoIssue(null)).toMatch(/无法登记/);
  });
});
