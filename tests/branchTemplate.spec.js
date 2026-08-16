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
    // ★ media_metadata: true 是行为钉子：Admin API 对视频**默认不回 duration**
    //   （2026-08-14 生产实测，mock 盖不住这层差异）——去掉这个选项登记必炸
    expect(resourceSpy).toHaveBeenCalledWith(
      `ideahub/template-videos/${owner.id}-2001`,
      { resource_type: "video", media_metadata: true },
    );
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

  test("资源存在但不过**参考视频**窗口（40s 长片）→ 400 整句", async () => {
    // ★ 这条 V1 登记路把**整段原片直接当参考视频**用，所以复核走的是严窗口
    //   （templateRefIssue，[4,30]s + F3），不是上传口那套放宽后的原始素材窗口。
    //   拿松窗口复核的话，一段 300s 的素材会被登记成模板，然后每个套用它的人在
    //   付费出片那一步撞 400 —— 而方舟受理后失败是不退费的。
    resourceSpy.mockImplementation(async (publicId) => fakeResource(publicId, { duration: 40 }));
    const res = await request(app)
      .post("/api/branch/templates")
      .set(asOwner())
      .send(validBody(videoUrlOf(owner.id, 2004)));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/最长 30 秒/);
  });

  test("★★ 回执给小数时长（12.4s）→ 锚点 ceil 成 13，真值 12.4 另存一位", async () => {
    // ★★ refVideo.durationSec 只有**两个**写入方（这条 V1 登记路 + V2 的 finish），
    //   两边必须用同一个取法，否则就是"两种模板两套报价"。
    // ★ 为什么必须取整：App 的报价镜像**不 round 不 clamp**，服务端结算 round+clamp ——
    //   锚点是整数时两者恒等；存小数的那一刻页面报少、钱包扣多。
    // ★ 为什么是 ceil 不是 round：12.4 用 round 会存成 12，我们按 24s 收、方舟按 ~24.5s 计
    //   —— **报价 < 实收**，本仓头号事故形状。ceil 把误差永久钉在安全的那一侧。
    resourceSpy.mockImplementation(async (publicId) => fakeResource(publicId, { duration: 12.4 }));
    const tpl = await createTemplate(2005);
    expect(tpl.refVideo).toMatchObject({ durationSec: 13, realDurationSec: 12.4 });
    expect(Number.isInteger(tpl.refVideo.durationSec)).toBe(true);
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
describe("角色位编号由作者确认（PATCH /templates/:id/roles + 发布闸）", () => {
  // ★★ 这一组钉的是白模 V2 最阴的一条错法（F5）：白模化落库那一刻的 label 是**服务端
  //   按视觉清单顺序编的猜测**（1..N），而成片上人偶胸口的数字**稳定但不连续**
  //   （实测一发四人实出 1/2/4/5）。错位时套用者点"3 号位"挂上张三，模型老老实实换掉
  //   画面上的 3 号（另一个人）—— **钱照扣、零报错**，没有任何一层会喊。
  //   所以编号只能由**看得见画面的人**确认，且未确认的模板不许上市场。
  const BranchTemplate = () => require("../src/models/BranchTemplate");

  const twoRoles = () => [
    { label: "1", desc: "白发、黑金色长袍的少年" },
    { label: "2", desc: "红发红甲的女武士" },
  ];

  /**
   * 造一个「白模 V2 形状」的模板：走 V1 建模板路，再直接落 roles / provenAt。
   * ★ 不走 blockoutize：那条路要整套假方舟网络，而这里测的是**发布闸与核对端点本身**
   *   （与上面用 updateOne 模拟试炼通过同一种做法 —— 测什么就只造什么）。
   */
  async function v2Template(ts, { roles = twoRoles(), proven = true } = {}) {
    const tpl = await createTemplate(ts);
    await BranchTemplate().updateOne(
      { _id: tpl.id },
      { $set: { roles, ...(proven ? { provenAt: new Date() } : {}) } },
    );
    return tpl;
  }

  const patchRoles = (id, roles, who = asOwner) =>
    request(app).patch(`/api/branch/templates/${id}/roles`).set(who()).send({ roles });

  // ── 发布闸：两道独立的门 ────────────────────────────────────────────
  test("试炼过了但编号没核对 → 发布 400，且整句说的就是「核对编号」这件事", async () => {
    const tpl = await v2Template(6001);
    const denied = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(denied.status).toBe(400);
    // ★ 说的必须是编号这件事：这里如果落回试炼闸那句"先出一段片"，作者会去再花一次钱
    //   出片，回来发现还是发不了 —— 两道门必须各说各的
    expect(denied.body.message).toMatch(/核对/);
    expect(denied.body.message).toMatch(/编号/);
    expect((await BranchTemplate().findById(tpl.id).lean()).status).toBe("pending");
  });

  test("编号核对了但还没试炼 → 发布仍 400，说的是「先出一段片」（两道门不互相代替）", async () => {
    const tpl = await v2Template(6002, { proven: false });
    await patchRoles(tpl.id, twoRoles()).expect(200);
    const denied = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/出一段片|出片/);
  });

  test("两道门都过 → 发布成功，市场上出得来", async () => {
    const tpl = await v2Template(6003);
    const done = await patchRoles(tpl.id, twoRoles());
    expect(done.status).toBe(200);
    expect(done.body.template.roles.every((r) => r.labelConfirmed === true)).toBe(true);
    const ok = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(ok.status).toBe(200);
    expect(ok.body.template.status).toBe("published");
  });

  test("存量 V2 模板（roles 里根本没有 labelConfirmed 这一位）→ 判成未核对，不许发布", async () => {
    // ★ 本次改动之前建的模板就是这个形状。用原生驱动写入绕开 mongoose 的默认值填充 ——
    //   判据写成 `=== false` 的话这类文档会被当成"已核对"漏过去，而它们的编号
    //   确实一次都没有人核对过（后加字段判等值那条坑的同族）。
    const tpl = await v2Template(6004, { roles: twoRoles() });
    await BranchTemplate().collection.updateOne(
      { _id: new mongoose.Types.ObjectId(tpl.id) },
      { $set: { roles: [{ label: "1", desc: "白发少年" }] } },
    );
    const denied = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/核对/);
  });

  test("V1 老模板（没有角色位）不受这道门影响：照旧只校试炼闸", async () => {
    // ★ 判据必须写存在性。写成"roles 不是全 true 就拦"的话，V1 模板会突然发布不了，
    //   而症状（"老模板怎么发不出去了"）完全指不到这条新代码。
    const tpl = await createTemplate(6005);
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date() } });
    const ok = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(ok.status).toBe(200);
    expect(ok.body.template.roles).toBeUndefined(); // V1 连这个键都不该出
  });

  // ── 核对端点本身 ────────────────────────────────────────────────────
  test("★ 收下**不连续、非 1..N** 的编号并原样存（F5：实出 1/2/4/5，重排就是把卡挂错人）", async () => {
    const tpl = await v2Template(6006);
    // 作者对着成片抄下来的：跳号、还多认出一个人（视觉那一步漏了）
    const authoritative = [
      { label: "1", desc: "白发、黑金色长袍的少年" },
      { label: "2", desc: "红发红甲的女武士" },
      { label: "4", desc: "画面最右侧的灰袍老人" },
      { label: "7", desc: "背景里抱猫的小孩" },
    ];
    const res = await patchRoles(tpl.id, authoritative);
    expect(res.status).toBe(200);
    // 逐字相同：不排序、不补 3/5/6、不改成 1..4
    expect(res.body.template.roles.map((r) => r.label)).toEqual(["1", "2", "4", "7"]);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "2", "4", "7"]);
    expect(doc.roles.every((r) => r.labelConfirmed === true)).toBe(true);
  });

  test("整份替换：作者能删掉 AI 多认的那一条（逐条 merge 的话这种修正表达不出来）", async () => {
    const tpl = await v2Template(6007);
    const res = await patchRoles(tpl.id, [{ label: "1", desc: "白发少年" }]);
    expect(res.status).toBe(200);
    expect(res.body.template.roles).toHaveLength(1);
  });

  test("编号重复 → 400，库里一个字都没改（重了的话套用侧的映射会静默互相覆盖）", async () => {
    const tpl = await v2Template(6008);
    const res = await patchRoles(tpl.id, [
      { label: "2", desc: "甲" },
      { label: "2", desc: "乙" },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/编号/);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "2"]);
    expect(doc.roles.every((r) => r.labelConfirmed === true)).toBe(false); // 没被误标成已核对
  });

  test("非作者不能核对（403，身份只认 ownerId），库不变", async () => {
    const tpl = await v2Template(6009);
    const res = await patchRoles(tpl.id, [{ label: "9", desc: "冒名改的" }], asOther);
    expect(res.status).toBe(403);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "2"]);
  });

  test("未登录 → 401", async () => {
    const tpl = await v2Template(6010);
    const res = await request(app).patch(`/api/branch/templates/${tpl.id}/roles`).send({ roles: twoRoles() });
    expect(res.status).toBe(401);
  });

  test("已发布的模板不许改编号（先下架）——改了等于把别人手里的「几号位挂谁」偷偷换掉", async () => {
    const tpl = await v2Template(6011);
    await patchRoles(tpl.id, twoRoles()).expect(200);
    await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner()).expect(200);

    const denied = await patchRoles(tpl.id, [{ label: "5", desc: "改过的" }]);
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/下架/);
    // 下架之后就能改了（改动可见，市场上那条先消失）
    await request(app).patch(`/api/branch/templates/${tpl.id}/unpublish`).set(asOwner()).expect(200);
    expect((await patchRoles(tpl.id, [{ label: "5", desc: "改过的" }])).status).toBe(200);
  });

  test("blocked（平台下架）的模板同样改不动", async () => {
    const tpl = await v2Template(6012);
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { status: "blocked" } });
    const res = await patchRoles(tpl.id, twoRoles());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/平台/);
  });

  test("V1 模板调核对端点 → 400，且**不凭空造出角色位**", async () => {
    const tpl = await createTemplate(6013);
    const res = await patchRoles(tpl.id, [{ label: "1", desc: "编出来的" }]);
    expect(res.status).toBe(400);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles).toBeUndefined();
  });

  test("空 roles / 缺 roles → 400（zod）：核对成「一个角色位都没有」不是合法的确认", async () => {
    const tpl = await v2Template(6014);
    expect((await patchRoles(tpl.id, [])).status).toBe(400);
    expect((await request(app).patch(`/api/branch/templates/${tpl.id}/roles`).set(asOwner()).send({})).status).toBe(400);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles).toHaveLength(2);
  });

  test("核对端点碰不到钱与身份：塞 refVideo/source/status/ownerId 全被 strip", async () => {
    // ★ 这条端点是**唯一**收客户端 roles 的地方，所以要钉住它没顺手开别的口子 ——
    //   durSec/refVideo 是 r2v 的计价锚点，从这里改得动就等于让用户自己标价。
    const tpl = await v2Template(6015);
    const res = await request(app)
      .patch(`/api/branch/templates/${tpl.id}/roles`)
      .set(asOwner())
      .send({
        roles: [{ label: "1", desc: "白发少年" }],
        status: "published",
        ownerId: other.id,
        provenAt: null,
        refVideo: { durationSec: 1, url: "https://evil.example.com/x.mp4" },
        source: { publicId: "ideahub/template-videos/hack-1", startSec: 0, durSec: 1, crop: { x: 0, y: 0, w: 1, h: 1 } },
      });
    expect(res.status).toBe(200);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.status).toBe("pending");
    expect(String(doc.ownerId)).toBe(String(owner.id));
    expect(doc.refVideo.durationSec).toBe(10); // Cloudinary 的登记值，不是客户端报的 1
    expect(doc.refVideo.url).toContain("res.cloudinary.com");
    expect(doc.source).toBeUndefined();
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

  // ★★ 上传口走的是**原始素材**那套窗口（V2 起放宽）：真正要满足方舟约束的是
  //   "编辑页框选、服务端裁出来的那一段"，原片本身不再直接进方舟。
  //   所以这里**不再**拒 3s / 20s / 细长比例 —— 那三条现在都是合法素材
  //   （下面另有一组正面钉住"确实放行了"）。
  test.each([
    ["太长（700s）", { duration: 700 }, /最长 600 秒/],
    ["边长不够（200×3000）", { width: 200, height: 3000 }, /边长至少 300 像素/],
    ["像素数不够（640×360）", { width: 640, height: 360 }, /分辨率太低/],
    // ★★ 2026-08-16 新增的下限：原片短于 5 秒 → 裁出来的那一段必然也 <5 秒
    //   （裁剪不可能比原片长），而 4 秒进方舟做白模只剩 3.7 秒 —— 那样的模板谁都套用不了。
    //   拦在**上传之前**（App 本机读 `<video>` 元数据就够）是最早的止损点：连 100MB 都不用传。
    ["太短（3.6s）", { duration: 3.6 }, /至少 5 秒/],
    // ★★★ 这一条钉的是**根因本身**：老代码里 `templateVideoMeta` 对 duration 做
    //   `Math.round`，`Math.round(4.6) === 5` 会让这段素材**顺利放行**，然后用户框选 5 秒
    //   （超出片长）或框 4 秒撞方舟。取整一旦回来，只有这一条会红。
    ["太短且四舍五入会放行（4.6s → 老代码读成 5）", { duration: 4.6 }, /只有约 4.6 秒/],
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

  test.each([
    // ★ 5 秒是**白模输入下限**（BLOCKOUT_MIN_INPUT_SEC），不是方舟的窗口 —— 端点上要收得下
    ["5 秒（刚好够白模输入的下限）", { duration: 5 }],
    ["3 分钟长片（V2 的素材本来就长）", { duration: 180 }],
    ["细长比例 500×1500（比例正是裁剪框能修的那一项）", { width: 500, height: 1500 }],
  ])("原始素材窗口放宽后：%s → 200 放行，且不回收", async (_label, over) => {
    // ★ 这一组是**放宽方向**的钉子。只钉"该拒的拒"是不够的：把窗口悄悄改回严的，
    //   症状是"一段 3 分钟的素材连传都传不上来，而它裁出来的 8 秒完全合格"——
    //   用户根本没法开始，而上面那组测试照样全绿。
    mockUploadReceipt(over);
    const res = await request(app)
      .post("/api/uploads/template-video")
      .set(asOwner())
      .attach("video", Buffer.from("fake-mp4"), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(200);
    expect(destroySpy).not.toHaveBeenCalled();
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

  test("未登录 → 401（每一发都是 100MB 级出网 + 永久配额，不许裸奔）", async () => {
    const res = await request(app)
      .post("/api/uploads/template-video")
      .attach("video", Buffer.from("x"), { filename: "a.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("白模化两阶段（POST …/blockoutize + POST …/blockoutize/finish）", () => {
  // ★ 这条链路**花两次真钱**（看帧的 chat + r2v 出片），而且 r2v 一旦被受理就
  //   **失败也不退费**（F11：含真人脸的视频创建时不拒、跑到一半才 failed）。
  //   所以每一道"能把用户的钱扔掉"的闸门都要从行为上钉住：
  //     ① 归属校验     —— 松了就能拿别人的素材开炼
  //     ② 四组数校验   —— 松了就在方舟那一步才 400，而钱已经扣了
  //     ③ 预热（F9）   —— 不预热就可能把半截视频喂给方舟，产出是废片、钱照扣
  //     ④ 服务端拼 URL —— 客户端拿得到 URL = 让用户自己标价（du_ 就是计价输入时长）
  //     ⑤ roles 为空拒 —— 建一个点不了角色位的空壳，用户只会以为"点了没反应"
  //     ⑥ 转存失败不落库 —— 方舟地址 24h 过期，留下的模板明天就是死链且零症状
  //
  // ★★ 2026-08-16 拆成两阶段之后，这一组的用例**一条都没删**，只是从"一发同步请求"
  //   改成"走完两段"（帮手 run()）—— 断言逐条对齐拆分前。删掉它们等于把拆分当成
  //   "重写"，那些闸门是怎么没的就没人知道了。另加四组两阶段特有的：
  //     · 幂等（连调两次 finish 只出一个模板）
  //     · 归属（别人拿到 jobId 也取不走）
  //     · 过期（24h 之后整句拒，且说清楚钱挽不回来）
  //     · 任务还在跑（整句「还没出片，稍后再来取」，**不是报错**）
  const BranchTemplate = () => require("../src/models/BranchTemplate");
  const BlockoutJob = () => require("../src/models/BlockoutJob");
  const walletSvc = require("../src/services/tokenWallet.service");
  const { SEEDANCE_2_5, r2vTokens, CHAT_TURN_TOKENS } = require("../src/config/tokens");

  const ARK = "https://ark.cn-beijing.volces.com/api/v3";

  let fetchSpy;
  let uploadSpy;
  /** 转存回执（产物的 public_id 里带 Date.now()，只能在跑完之后回读） */
  let lastUpload;
  /** 每条用例可改的行为开关（默认是 happy path） */
  let net;

  // ★ 每条用例默认用一段**没用过**的素材：白模化对同一段素材只许做一次
  //   （第一次的 source 就占住它了）。共用同一个 id 的话，后面的用例全会撞上
  //   "这段素材已经做过"，而错误信息与它们要测的东西对不上 —— 排查起来极其误导。
  // 8500 起：与下面几条用例里写死的 8002~8015 分开，免得撞成"这段素材已经做过"
  let pidSeq = 8500;
  function nextPid() {
    pidSeq += 1;
    return `ideahub/template-videos/${owner.id}-${pidSeq}`;
  }

  function baseBody(over = {}) {
    return {
      publicId: nextPid(),
      startSec: 2,
      durSec: 8,
      crop: { x: 0, y: 0, w: 900, h: 512 }, // 460,800 ≥ 407,696，比例 1.76
      title: "白模跑酷 V2",
      intro: "从一段实拍里裁出来的",
      coverUrl: "",
      videoTier: "ultra",
      aspect: "landscape",
      ...over,
    };
  }

  /** 方舟任务 id 的自增器。★ **绝不能全测试共用一个固定 id**：取件凭据按 taskId 建了
   *  唯一索引（一个方舟任务只许有一张取件单），共用同一个 id 的话第二条用例开炼时会撞上
   *  第一条那张单子，然后"取回结果"取到的是上一条用例的模板 —— 症状极其误导。
   *  真实的方舟每次也给不同的 id。 */
  let taskSeq = 0;

  /** 记录所有出网请求，按 URL 分派。★ 断言"服务端拼的那条 URL 原样进了方舟"靠它 */
  function installNet() {
    net = {
      headBytes: [4_000_000, 4_000_000], // 连续两次相同 = 预热完成
      frameOk: true,
      visionText: "1|画面正中央|白发、黑金色长袍的少年\n2|左侧靠前|红发红甲的女武士",
      taskAccepted: true,
      taskStatus: "succeeded",
      calls: [],
    };
    let headN = 0;
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (url, init = {}) => {
      const u = String(url);
      net.calls.push({ url: u, method: init.method || "GET", body: init.body });
      // ① 预热：HEAD 变换地址
      if (init.method === "HEAD") {
        const bytes = net.headBytes[Math.min(headN, net.headBytes.length - 1)];
        headN += 1;
        // net.headNoLength = 模拟"生成中的派生资产以 chunked 回，HEAD 一个长度都没有"
        return {
          ok: bytes !== null,
          status: bytes === null ? 500 : 200,
          headers: { get: () => (net.headNoLength ? null : String(bytes ?? 0)) },
        };
      }
      // ①b 预热的兜底：Range: bytes=0-0 的 GET，从 content-range 的分母读总长
      if (init.headers?.Range) {
        const bytes = net.headBytes[Math.min(headN - 1, net.headBytes.length - 1)];
        return {
          ok: true,
          status: 206,
          headers: { get: (k) => (k === "content-range" ? `bytes 0-0/${bytes}` : null) },
        };
      }
      // ② 抽帧
      if (u.endsWith(".jpg")) {
        if (!net.frameOk) return { ok: false, status: 404, headers: { get: () => null } };
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k === "content-type" ? "image/jpeg" : null) },
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        };
      }
      // ③ 方舟：看帧
      if (u === `${ARK}/chat/completions`) {
        return {
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: net.visionText } }] }),
        };
      }
      // ④ 方舟：建 r2v 任务
      if (u === `${ARK}/contents/generations/tasks`) {
        if (!net.taskAccepted) {
          return { status: 400, text: async () => JSON.stringify({ error: { message: "输入视频不合格" } }) };
        }
        taskSeq += 1;
        return { status: 200, text: async () => JSON.stringify({ id: `cgt-blockout-${taskSeq}` }) };
      }
      // ⑤ 方舟：查任务状态（阶段二的"自己核实"走这条；客户端轮询走 /api/ark 那条）
      if (u.startsWith(`${ARK}/contents/generations/tasks/`)) {
        const id = u.slice(u.lastIndexOf("/") + 1);
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              id,
              status: net.taskStatus,
              ...(net.taskStatus === "succeeded"
                ? { content: { video_url: "https://x.volces.com/out.mp4" } }
                : { error: { message: "内容审核未通过" } }),
            }),
        };
      }
      throw new Error(`测试里没有为这个地址准备回应：${u}`);
    });
  }

  beforeAll(async () => {
    // ★ 变换 URL 要用 cloud_name 拼（测试环境没有 .env）。给一个假的就够：
    //   出网全被 fetch 间谍接管，这里只影响拼出来的字符串。
    cloudinary.config({ cloud_name: "demo", api_key: "test-key", api_secret: "test-secret" });
    // 2.5 是 paidOnly，且一发 r2v 就是百万级 token —— 作者得是付费用户且钱包够
    await walletSvc.buyPlan(owner.id, "pro");
    await walletSvc.credit(owner.id, 50_000_000, "recharge", "测试预置额度");
  });

  beforeEach(() => {
    process.env.ARK_API_KEY = "test-key";
    installNet();
    // 原片：1920×1080 / 60s（四组数都落在里面）
    resourceSpy.mockImplementation(async (publicId) => ({
      public_id: publicId,
      secure_url: `${CLOUD_PREFIX}/${publicId}.mp4`,
      duration: 60,
      width: 1920,
      height: 1080,
      bytes: 30_000_000,
      version: 1712000000,
    }));
    // 转存回执：合格的白模产物（900×512 / **7.712s**）
    // ★★★ 这个小数是本组最重要的一个数（2026-08-16 补）。在它之前这里写的是整数 8，
    //   而**整仓没有一处**用小数 duration 的回执做过测试 —— 那就是「产物短于方舟下限」
    //   那个 bug 隐身的全部原因：`templateVideoMeta` 当年对 duration 做 `Math.round`，
    //   喂整数进去 round 是恒等的，于是产物窗口那道闸门看着有、实际被喂假数。
    //   方舟 edit 的产出**本来就比输入短**（实测 4.0→3.712、5.0→4.736、14.04→13.67），
    //   回执里给的一直是小数。把这里改回整数，下面所有关于 ceil 锚点与产物验收的钉子
    //   会一起变成走过场。
    lastUpload = null;
    uploadSpy = jest.spyOn(cloudinary.uploader, "upload").mockImplementation(async (_url, opts) => {
      lastUpload = {
        public_id: `${opts.folder}/${opts.public_id}`,
        secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
        duration: 7.712,
        width: 900,
        height: 512,
        bytes: 3_000_000,
      };
      return lastUpload;
    });
  });

  afterEach(() => {
    delete process.env.ARK_API_KEY;
    fetchSpy.mockRestore();
    uploadSpy.mockRestore();
  });

  /** 阶段一：开炼（到"方舟受理了"为止，钱在这里花掉） */
  async function post(body, who = asOwner) {
    return request(app).post("/api/branch/templates/blockoutize").set(who()).send(body);
  }

  /** 阶段二：取回结果（**不花钱**，服务端自己向方舟核实） */
  async function finish(jobId, who = asOwner, extra = {}) {
    return request(app)
      .post("/api/branch/templates/blockoutize/finish")
      .set(who())
      .send({ jobId, ...extra });
  }

  /**
   * 两阶段走完 —— 等价于拆分前那一发同步请求。
   * ★ 大多数用例关心的是"整条链路的行为"而不是"哪一阶段"，共用这个帮手之后，
   *   断言与拆分前逐条对齐（改坏了任何一段都会红在原来那条用例上）。
   */
  async function run(body, who = asOwner) {
    const started = await post(body, who);
    expect(started.status).toBe(202); // 阶段一只是受理，**什么都还没建出来**
    const finished = await finish(started.body.jobId, who);
    return { started, finished, jobId: started.body.jobId };
  }

  // ── happy path ──────────────────────────────────────────────────────
  test("两阶段走完 → 201：roles 出、source 不出、status=pending、refVideo 是转存后的地址", async () => {
    const body = baseBody();
    const { started, finished: res } = await run(body);

    // 阶段一的受理回执：客户端靠它拿到取件凭据 + 自己轮询的 taskId
    expect(started.body).toMatchObject({ ok: true, state: "accepted", durSec: 8, billed: true });
    expect(typeof started.body.jobId).toBe("string");
    expect(started.body.taskId).toMatch(/^cgt-/); // 客户端拿它去既有的轮询端点自己跟进
    // ★ 有效期是 **24 小时**（方舟产物是 TOS 签名地址、24h 过期，F12）——
    //   写成 48h 的话用户会在第 30 小时回来取，撞上一句拉不到产物的失败，而钱早花了
    const ttlH = (new Date(started.body.expiresAt) - Date.now()) / 3600_000;
    expect(ttlH).toBeGreaterThan(23.5);
    expect(ttlH).toBeLessThanOrEqual(24);
    // 角色位草案随受理回执一起给（App 要马上显示"AI 在这段里认出了谁"）
    expect(started.body.roles.map((r) => r.label)).toEqual(["1", "2"]);

    expect(res.status).toBe(201);
    expect(res.body.state).toBe("done");
    // ★ 取回结果这一步**一分钱不花**：它的失败是"没取到"，不是"又花了一笔"
    expect(res.body.billed).toBe(false);
    const tpl = res.body.template;

    expect(tpl.status).toBe("pending"); // 试炼闸照旧：作者自己跑通一次才能发布
    expect(tpl.provenAt).toBeNull();
    // 角色位来自视觉清单；label 是**字符串**（F5：方舟给的编号不连续，别假设 1..N）。
    // ★ labelConfirmed 出生就是 false：这份编号是 AI 猜的，作者点头之前不许当真（F5）
    expect(tpl.roles).toEqual([
      { label: "1", desc: expect.stringContaining("白发"), labelConfirmed: false },
      { label: "2", desc: expect.stringContaining("红发"), labelConfirmed: false },
    ]);
    // ★ source **不出公开响应**：它指向作者自己上传的原始素材（可能有版权）
    expect(tpl.source).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(body.publicId);
    // refVideo 是**转存后**的地址（F12：方舟那条 TOS 地址 24h 就过期）
    expect(tpl.refVideo.url).toBe(lastUpload.secure_url);
    // ★★ 两个时长是**两件事**，都要出：
    //   · durationSec = 计价锚点，恒为 [4,30] 内的**整数**，由真实秒数 `Math.ceil` 而来。
    //     为什么必须是整数：App 的报价公式不 round 不 clamp，服务端的 round+clamp ——
    //     锚点是整数时两者恒等，存小数的那一刻就是"页面报少、钱包扣多"（本仓头号事故形状）。
    //   · realDurationSec = 云端回执里的**真实小数**，只诊断/展示，不参与任何计价。
    //     不存它的话，"这个模板到底够不够方舟的 4 秒下限"在库里无从判断（锚点是向上取整的，
    //     一段 3.712s 的坏产物在那里写着 4）。
    expect(tpl.refVideo).toMatchObject({ durationSec: 8, realDurationSec: 7.712, width: 900, height: 512 });
    expect(Number.isInteger(tpl.refVideo.durationSec)).toBe(true);
    expect(uploadSpy).toHaveBeenCalledWith("https://x.volces.com/out.mp4", expect.objectContaining({ resource_type: "video" }));

    // 库里存了 source（溯源与重做要用），只是不回给客户端
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.source).toMatchObject({
      publicId: body.publicId,
      startSec: 2,
      durSec: 8,
      crop: { x: 0, y: 0, w: 900, h: 512 },
    });
  });

  test("★ 端到端：白模化刚做出来的模板发布不了 —— 编号还等着作者核对", async () => {
    // ★ 这条与「角色位编号由作者确认」那一组是两回事：那组测的是闸门本身（模板是造的），
    //   这条测的是**真走完九步**的产物身上也带着这道门 —— 中间任何一处顺手把
    //   labelConfirmed 填成 true（比如为了"少一步"），只有这条会红。
    const { finished: made } = await run(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8016` }));
    expect(made.status).toBe(201);
    const id = made.body.template.id;
    // 试炼闸先满足（模拟作者自己跑通了一发），把编号那道门单独露出来
    await BranchTemplate().updateOne({ _id: id }, { $set: { provenAt: new Date() } });
    const denied = await request(app).patch(`/api/branch/templates/${id}/publish`).set(asOwner());
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/核对/);
    // 作者核对完（这一发是唯一收客户端 roles 的路）→ 才发得出去
    await request(app)
      .patch(`/api/branch/templates/${id}/roles`)
      .set(asOwner())
      .send({ roles: [{ label: "1", desc: "白发少年" }, { label: "4", desc: "红发女武士" }] })
      .expect(200);
    const ok = await request(app).patch(`/api/branch/templates/${id}/publish`).set(asOwner());
    expect(ok.status).toBe(200);
    expect(ok.body.template.roles.map((r) => r.label)).toEqual(["1", "4"]); // 跳号原样保留
  });

  test("★ 变换 URL 由服务端拼、原样进方舟（客户端一个 URL 都没给过）", async () => {
    const sent = baseBody();
    await post(sent);
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const body = JSON.parse(create.body);
    const ref = body.content.find((c) => c.type === "video_url");
    // so_/du_/c_crop 就是用户框的那四组数 —— `du_` 正是 r2v 的计价输入时长
    expect(ref.video_url.url).toContain("/so_2,du_8,c_crop,x_0,y_0,w_900,h_512/");
    expect(ref.video_url.url).toContain(`/${sent.publicId}.mp4`);
    expect(ref.role).toBe("reference_video");
    // 四参数与计价假设绑死（与 resolveR2v 的钉子同一组）
    expect(body).toMatchObject({
      model: SEEDANCE_2_5,
      omni_reference_task_type: "edit",
      duration: -1,
      ratio: "adaptive",
      resolution: "720p",
    });
    // F4：白模化提示词必须**点名**（"包括…在内"），泛指会漏掉主角
    const text = body.content.find((c) => c.type === "text").text;
    expect(text).toContain("包括");
    expect(text).toContain("白发");
    expect(text).toContain("头部前后左右四面");
  });

  test("★ 编号印在**头部四面**、四处是**同一个**数字（胸口那个转身就看不见了）", async () => {
    // ★★ 2026-08-15 实测：胸口那个号本身清晰稳定、跨帧不串号，但人物一转身/背对镜头/
    //   换机位就**看不见** —— 而编号是"点这个人偶挂这张卡"的唯一连接键，看不见的那几帧
    //   对套用侧就等于"这个人没有号"。所以要四面都印。
    // ★ 措辞里"**同一个**"这半句必须在：只说"头部四面各印一个编号"时，
    //   模型完全可能给同一个人偶印四个不同的号 —— 那比印在胸口还糟（作者核对时
    //   看哪一面都对不上，而列表里那格看着毫无问题）。
    await post(baseBody());
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const text = JSON.parse(create.body).content.find((c) => c.type === "text").text;
    expect(text).toMatch(/头部前后左右四面/);
    expect(text).toMatch(/同一个/);
    // 「取值范围钉死」那条老规矩没被这次改动带走（不写的话实测印出 115/116 这种号码牌）
    expect(text).toMatch(/只用 1 到 2/);
    expect(text).toMatch(/不要多位数/);
    // ★ 胸口那一处是**故意去掉**的：同一个号印在五个地方 = 五次各自印错的机会，
    //   而两处数字不一样时没有任何人能判哪个对（作者核对看哪个？套用者看哪个？）。
    expect(text).toMatch(/身上别处不要有数字或文字/);
  });

  test("★ 编号是**从点名清单抄**的，不是让模型自己编（自己编会重号又漏号）", async () => {
    // ★★ 2026-08-15 实测钉下来的：措辞写成「给每个人偶编上 1 到 N 的编号」时，
    //   等于把"谁是几号"当成一件**独立的分配活儿**交给模型 —— 5 人素材实出
    //   **2/2/1/1/5**（两个 2、两个 1，3 和 4 整个没了），且三帧稳定复现、零报错。
    //   而点名清单里 `3=红双马尾…` 本来就把号与人绑好了，让它照抄既省注意力、
    //   又没有自由发挥的余地。这一句一旦被"优化"掉，症状是**套用者把卡挂到别人身上**：
    //   列表里 1..N 齐整，画面上却重号漏号，两边都不报错。
    await post(baseBody());
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const text = JSON.parse(create.body).content.find((c) => c.type === "text").text;
    expect(text).toMatch(/清单写几号的那个人，他的人偶头上就印几号/);
    expect(text).toMatch(/不许重复也不许漏号/);
    // ★★ 反向钉一条：**不许**再出现"正好 N 个带号的人偶／每个号各出现一次"那种总量自查。
    //   看着更严谨，实测反而让模型去"凑一套连号"——按画面从左到右重编成 1/1/2/3/4，
    //   而清单里最左边那个是 3 号。重号只挂错一个人，**按位置重编是整份映射全错**。
    //   （详见 blockoutPrompt 函数头 ★★⑤，那一发 605 字，抹外观也跟着退了。）
    expect(text).not.toMatch(/各出现一次/);
  });

  test("★ 提示词总长度有预算：编号段不许再膨胀（膨胀就是拿「抹掉外观」去换）", async () => {
    // ★★ 这一条不是洁癖，是 2026-08-15 三发对照实测的结论：
    //   编号段六行（~205 字、全长 ~700 字）那一发，头上的号完全正确，
    //   **衣服和头发却原封不动** —— 做出来是"穿着原衣服的球关节人偶"；
    //   同素材同参数把编号段压到两行（全长 ~594 字）复跑，衣服头发被抹得干干净净。
    //   开头那三句"没有头发/没有服装/不许保留原有的发型发色面部或衣服"一个字没动，
    //   位置也还在最强的开头 —— 它们顶不住的是**总长度**。
    // ★ 所以这里钉的是"别再让它长回去"。真要加句子，就在别处还回来
    //   （"清单之外的人"那条就是这么压成一行的）。上限取实测通过值 594 + 余量。
    //   ⚠ 它随角色位数量增长（每人一行点名），所以按 2 人这个固定 fixture 量。
    await post(baseBody());
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const text = JSON.parse(create.body).content.find((c) => c.type === "text").text;
    expect(text.length).toBeLessThan(600);
  });

  // ── 看几帧（自动按时长 / 用户自选）───────────────────────────────────
  //
  // ★★ 2026-08-15 真机实测的坑：帧数写死 3 帧时，一段 4 秒素材（前半段 2 人、后半段围坐
  //   群戏人更多）只认出 2 个人 —— 登记的角色位是 1、2，而方舟出片时看到更多人
  //   **自己往下编到了 3**。画面上有 3 号、列表里没有第三格，套用者挂不上卡且**零报错**。
  //   现在帧数由 blockout.visionFrameTimes 一处说了算（自动 3~8 帧 / 用户自选），
  //   下面这一组把"帧数真的随时长变、自选真的进得来、坏值真的被服务端自己丢掉"逐条钉住。
  // ★ 用**真正打出去的抽帧请求**做断言（不是只看回包里的数）：两者对不上就是
  //   "回执说看了 8 帧、其实只抽了 3 帧"，而 App 拿回执对账 —— 那是在账上撒谎。
  /** 这一发实际抽了哪几个时刻的帧（原片上的绝对秒数，从 so_ 里读回来） */
  const frameSecs = () =>
    net.calls
      .filter((c) => c.url.endsWith(".jpg"))
      .map((c) => Number(/\/so_([\d.]+),c_crop/.exec(c.url)[1]));

  test.each([
    // ★ 2026-08-16 起白模输入下限是 5 秒（见 BLOCKOUT_MIN_INPUT_SEC），所以这条走 HTTP 的
    //   最短样本从 4 改成 5。「clamp 的下限 3 帧」现在从这条路走不到了（ceil(5/1.5)=4），
    //   它归下面那组**单元**测试钉（visionFrameTimes(4) 仍然是 3 帧）—— 两层各钉各的。
    ["5 秒 → ceil(5/1.5) = 4 帧（白模输入的最短合法样本）", 5, 4],
    ["8 秒 → 每 1.5 秒一帧 = 6 帧", 8, 6],
    ["12 秒 → 8 帧封顶（ceil(12/1.5)=8）", 12, 8],
    ["30 秒 → 仍是 8 帧（再长也不多看）", 30, 8],
  ])("自动模式：%s", async (_label, durSec, want) => {
    const started = await post(baseBody({ startSec: 0, durSec }));
    expect(started.status).toBe(202);
    // 回执里的数 = 真正喂进模型的帧数（App 拿它对账报价的前一半）
    expect(started.body.visionFrames).toBe(want);
    const secs = frameSecs();
    expect(secs).toHaveLength(want);
    // 升序、去重、都落在这一段**里面**（右端是开的）
    expect([...secs].sort((a, b) => a - b)).toEqual(secs);
    expect(new Set(secs).size).toBe(secs.length);
    for (const s of secs) expect(s).toBeGreaterThanOrEqual(0);
    for (const s of secs) expect(s).toBeLessThan(durSec);
  });

  test("自动模式抽的时刻是**原片上的绝对秒**（相对片段的偏移要加上 startSec）", async () => {
    // ★ 帧地址切的是**原片**（`so_` 是原片上的时刻），而 visionFrameTimes 回的是片段内的
    //   相对秒。漏加 startSec 的话，AI 看的是这一段**之前**的画面 —— 人对不上、零报错。
    const started = await post(baseBody({ startSec: 20, durSec: 8 }));
    expect(started.status).toBe(202);
    const secs = frameSecs();
    expect(secs[0]).toBe(20); // 片段第一帧
    for (const s of secs) {
      expect(s).toBeGreaterThanOrEqual(20);
      expect(s).toBeLessThan(28);
    }
  });

  test("★ frameTimes 真的进得来（schema 里不显式声明就会被 zod strip，全程零报错）", async () => {
    // ★★ 这条钉的是 zod strip 那个坑本身：不声明的表现是"客户端发了、服务端 202 了、
    //   AI 照样只看自动那几帧" —— 用户在编辑页辛辛苦苦标的入场/离场帧一个都没生效，
    //   而两边都不报错。所以要用一组**与自动模式明显不同**的时刻来钉（自动是 6 帧）。
    const started = await post(baseBody({ startSec: 2, durSec: 8, frameTimes: [0, 3, 7] }));
    expect(started.status).toBe(202);
    expect(started.body.visionFrames).toBe(3);
    expect(frameSecs()).toEqual([2, 5, 9]); // startSec + 相对秒
  });

  test("自选：越界的**丢掉**、剩下的照用（不整条拒 —— 用户已经付过上传与框选的时间成本）", async () => {
    const started = await post(baseBody({ startSec: 2, durSec: 8, frameTimes: [2, 1, 8, 30] }));
    expect(started.status).toBe(202);
    // 8 与 30 都 ≥ durSec（右端开）→ 丢掉；剩下的去重排序
    expect(started.body.visionFrames).toBe(2);
    expect(frameSecs()).toEqual([3, 4]);
  });

  test("自选：空数组 → **退回自动**（不是「一帧都不看」）", async () => {
    // ★ 返回空的表现是"没抽帧 → 视觉认不出人 → 在 roles 为空那里被拒"，
    //   而用户看到的理由会是"AI 没认出人"，与真正原因完全对不上。
    const started = await post(baseBody({ startSec: 0, durSec: 8, frameTimes: [] }));
    expect(started.status).toBe(202);
    expect(started.body.visionFrames).toBe(6);
  });

  test("自选：全部越界 → 同样退回自动，绝不空手去看", async () => {
    const started = await post(baseBody({ startSec: 0, durSec: 8, frameTimes: [8, 9, 40] }));
    expect(started.status).toBe(202);
    expect(started.body.visionFrames).toBe(6);
  });

  test("自选超过上限（9 个）→ 400，且**一分钱不花**（连 Cloudinary 都不查）", async () => {
    // ★ 上限只有 blockout.VISION_FRAMES_MAX 一处，schema 从那里 import ——
    //   这里 400 是好事：还没花钱就说清楚，比截断之后让用户以为"我标的都看了"诚实。
    const before = await walletSvc.getWallet(owner.id);
    const res = await post(baseBody({ startSec: 0, durSec: 20, frameTimes: [0, 1, 2, 3, 4, 5, 6, 7, 8] }));
    expect(res.status).toBe(400);
    expect(resourceSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await walletSvc.getWallet(owner.id);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  test("★ 提示词兜底：清单之外的人也白模化，但**不给编号**", async () => {
    // ★★ 我们只看几帧，而画面里的人会中途入场/离场 —— 清单之外的人一定会有。
    //   宁可让它**没号**（挂不上卡、保持白模原样）也不要一个列表里没有的号：
    //   多出来的号是一句我们兑现不了的承诺，用户看得见却挂不上，只会以为坏了。
    await post(baseBody());
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const text = JSON.parse(create.body).content.find((c) => c.type === "text").text;
    expect(text).toMatch(/清单之外若还出现别的人物/);
    expect(text).toMatch(/不给编号/);
    expect(text).toMatch(/头上身上保持空白/);
  });

  test("★ 视觉认出 12 个 → 只登记 9 个角色位，label 恒为连续的 1..9", async () => {
    // ★★ 上限 9 的两头都是实测（见 blockout.BLOCKOUT_ROLE_MAX 的注释）：
    //   上界是参考图预算（9 × 每张人物卡 2~3 张图 = 18~27，仍在方舟 2.5 的 30 张之内），
    //   下界是人眼（12 个时编号照样印得出来，但画面上人能稳定认出的只有 4~5 个）。
    // ★★ 截断必须发生在**编号之前**：先编号再截断会留下 1、2、4… 这种断号，
    //   而提示词里说的还是"依次编到 N" —— 画面上的号与列表里的号从此系统性错位，
    //   两边都不报错（labelConfirmed 那道闸只是兜底，不是让编号一开始就对的办法）。
    net.visionText = Array.from({ length: 12 }, (_, i) => `${i + 1}|位置${i + 1}|第 ${i + 1} 个人的样子`).join("\n");
    const started = await post(baseBody());
    expect(started.status).toBe(202);
    expect(started.body.roles.map((r) => r.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    // 提示词里的"编到 N"跟着截断后的个数走（不是视觉认出的 12）
    const create = net.calls.find((c) => c.url === `${ARK}/contents/generations/tasks`);
    const text = JSON.parse(create.body).content.find((c) => c.type === "text").text;
    expect(text).toMatch(/只用 1 到 9/);
    expect(text).toMatch(/共 9 人/);
    expect(text).not.toMatch(/第 10 个人的样子/); // 被丢掉的那几个一个字都不该进提示词
    // 落库那份也是 9 条（取回结果这一步不许把丢掉的补回来）
    const finished = await finish(started.body.jobId);
    expect(finished.status).toBe(201);
    expect(finished.body.template.roles).toHaveLength(9);
    expect(finished.body.template.roles.map((r) => r.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  test("计价：钱**全在阶段一**花掉（看帧 chat + 按 durSec 算的 r2v），取回结果一分不加", async () => {
    const TokenLedger = require("../src/models/TokenLedger");
    const before = await walletSvc.getWallet(owner.id);
    const started = await post(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8002`, durSec: 12 }));
    expect(started.status).toBe(202);
    const afterStart = await walletSvc.getWallet(owner.id);

    const expected = CHAT_TURN_TOKENS + r2vTokens(12, SEEDANCE_2_5);
    expect(before.plan + before.addon - (afterStart.plan + afterStart.addon)).toBe(expected);
    // r2v 那笔的流水带来源标记（对账时分得出白模化那一发）
    const spend = await TokenLedger.findOne({
      user: owner.id,
      reason: "ark_spend",
      memo: new RegExp(`r2v src:ideahub/template-videos/${owner.id}-8002`),
    }).lean();
    expect(spend.delta).toBe(-r2vTokens(12, SEEDANCE_2_5));

    // ★★ 取回结果这一步**必须一分钱不花** —— 这正是 `billed:false` 那一位的实证。
    //   它要是也扣钱，用户就不敢重试，而"能再来取一次"是拆两阶段换来的全部东西。
    expect((await finish(started.body.jobId)).status).toBe(201);
    const afterFinish = await walletSvc.getWallet(owner.id);
    expect(afterFinish.plan + afterFinish.addon).toBe(afterStart.plan + afterStart.addon);
  });

  // ── ① 归属校验 ──────────────────────────────────────────────────────
  test.each([
    ["别人的 public_id", () => ({ publicId: `ideahub/template-videos/${other.id}-8003` })],
    ["别的目录", () => ({ publicId: `ideahub/workshop-media/${owner.id}-8003` })],
    ["形状不对（后缀不是时间戳）", () => ({ publicId: `ideahub/template-videos/${owner.id}-abc` })],
    ["多一层路径", () => ({ publicId: `ideahub/template-videos/evil/${owner.id}-8003` })],
  ])("归属校验：%s → 400，且不查 Cloudinary、不出网、不扣费", async (_label, over) => {
    const before = await walletSvc.getWallet(owner.id);
    const res = await post(baseBody(over()));
    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe("string"); // 整句可显示
    expect(res.body.billed).toBe(false);
    expect(resourceSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await walletSvc.getWallet(owner.id);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  test("同一段素材不许做第二次（第一次的 source 已经占住它）", async () => {
    const pid = `ideahub/template-videos/${owner.id}-8004`;
    const { finished } = await run(baseBody({ publicId: pid }));
    expect(finished.status).toBe(201);
    const again = await post(baseBody({ publicId: pid }));
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/已经做过/);
    expect(again.body.billed).toBe(false);
  });

  test("★ 同一段素材**还没取回结果**时也不许再开一发（不然同一段素材被扣两笔 r2v）", async () => {
    // ★★ 这是拆两阶段之后新出现的窗口：从"受理"到"取回"之间世上还没有模板，
    //   只判 BranchTemplate 的话这一句拦不住 —— 用户等出片时手一抖再点一次，
    //   第二笔几十万 token 就出去了，而两发都会成功，他只会看到"怎么多了一个一样的模板"。
    const pid = `ideahub/template-videos/${owner.id}-8017`;
    const started = await post(baseBody({ publicId: pid }));
    expect(started.status).toBe(202);
    const before = await walletSvc.getWallet(owner.id);
    const again = await post(baseBody({ publicId: pid }));
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/进行中|取回/);
    expect(again.body.billed).toBe(false);
    expect(again.body.jobId).toBe(started.body.jobId); // 告诉他去哪儿取，而不是只说"不行"
    const after = await walletSvc.getWallet(owner.id);
    expect(after.plan + after.addon).toBe(before.plan + before.addon); // 第二发一分钱没动
  });

  // ── ② 四组数校验 ────────────────────────────────────────────────────
  test.each([
    // 原片 1920×1080 / 60s
    ["裁剪框超出画面", { crop: { x: 1500, y: 0, w: 900, h: 512 } }, /裁剪框超出/],
    ["选段超出片长", { startSec: 55, durSec: 8 }, /超出了视频长度/],
    ["裁后像素不够（640×636 = 407,040）", { crop: { x: 0, y: 0, w: 640, h: 636 } }, /分辨率太低/],
    // ★★ 4 秒**方舟自己收得下**（它的窗口是 [4,30]），但白模这条路不行：产出只有 3.7 秒，
    //   低于方舟自己的下限，建出来的模板谁都套用不了 —— 而作者已经付过钱了。
    //   所以阶段一走的是 blockoutInputIssue（下限 5），不是 templateRefIssue（下限 4）。
    ["这一段刚好 4s —— 方舟收得下，但白模产出只剩 3.7s", { durSec: 4 }, /至少 5 秒/],
    // ★ 3 秒也要指向**真正的下限 5**，不能委托出去说成"至少要 4 秒"：
    //   用户照做改成 4 秒，回来又被拒一次 —— 一句指错数字的解释和一个坏功能长得一模一样。
    ["这一段太短（3s）", { durSec: 3 }, /至少 5 秒/],
    ["这一段太长（31s > 30s 上限）", { durSec: 31, startSec: 0 }, /最长 30 秒/],
    ["裁后比例过细长（400×1040）", { crop: { x: 0, y: 0, w: 400, h: 1040 } }, /宽高比/],
  ])("四组数校验：%s → 400 整句，且一分钱不花", async (_label, over, msgRe) => {
    const before = await walletSvc.getWallet(owner.id);
    const res = await post(baseBody(over));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(msgRe);
    expect(res.body.billed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); // 连预热都还没开始
    const after = await walletSvc.getWallet(owner.id);
    expect(after.plan + after.addon).toBe(before.plan + before.addon);
  });

  // ── ③ 预热（F9）─────────────────────────────────────────────────────
  // ★ Cloudinary 的变换是懒生成的，首次请求可能拿到**不完整**的资产（2026-08-15 实测：
  //   连发两次，字节数不一样）。不拦的话方舟拉到半截视频，产出是废片而**钱照扣**
  //   （受理后失败不退）。所以"连续两次读到相同且非零的字节数"才算准备好。
  test("预热：连续读到的字节数不稳定 → 502，且一次方舟都没打", async () => {
    net.headBytes = [1000, 2000, 3000, 4000, 5000, 6000]; // 永远不相等
    const res = await post(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8006` }));
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/还没把选中的这一段准备好|稍后重试/);
    expect(res.body.billed).toBe(false);
    // 关键：一次方舟都不许打（打了就是花钱）
    expect(net.calls.some((c) => c.url.startsWith(ARK))).toBe(false);
  });

  test("预热：HEAD 没有 content-length 时退到 Range 探测（否则整条白模化永远失败）", async () => {
    // ★ 正在生成中的派生资产完全可能以 chunked 回 —— 只认 HEAD 的话，这条链路会在
    //   "云端还没准备好"上永远失败，而它看起来像是 Cloudinary 的问题（查不到真因）。
    net.headNoLength = true;
    const res = await post(baseBody());
    expect(res.status).toBe(202);
    expect(net.calls.some((c) => c.url.endsWith(".mp4") && c.method === "GET")).toBe(true);
  });

  test("预热：连续两次相同才算准备好（读一次就走的话这条会红）", async () => {
    net.headBytes = [1000, 2000, 2000]; // 第 2、3 次才稳定
    const res = await post(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8007` }));
    expect(res.status).toBe(202);
    expect(net.calls.filter((c) => c.method === "HEAD").length).toBeGreaterThanOrEqual(3);
  });

  // ── ⑤ roles 为空 ────────────────────────────────────────────────────
  test("视觉一个人都没认出 → 整句拒、不建空壳模板（但看帧的钱确实花了，照实说）", async () => {
    net.visionText = "NONE";
    const res = await post(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8008` }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/没能.*认出|人物/);
    expect(res.body.billed).toBe(true); // 看帧那一步已经产生费用，不许粉饰成"没扣钱"
    // 没建模板，也没发 r2v（真正贵的那一步没花）
    expect(net.calls.some((c) => c.url === `${ARK}/contents/generations/tasks`)).toBe(false);
    expect(await BranchTemplate().findOne({ "source.publicId": `ideahub/template-videos/${owner.id}-8008` }).lean()).toBeNull();
  });

  // ── ⑥ 受理后失败 / 转存失败 ──────────────────────────────────────────
  test("方舟受理后 failed（F11 真人脸）→ 取回时整句说明**不退费**，不落库", async () => {
    net.taskStatus = "failed";
    const pid = `ideahub/template-videos/${owner.id}-8009`;
    const started = await post(baseBody({ publicId: pid }));
    expect(started.status).toBe(202); // 受理是真的：钱就是在这一步花掉的
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(502);
    // ★★ 两阶段之后 billed 分两件事说：**这一次调用**没花钱（false），
    //   但开炼那一笔**什么都没剩**（lost:true）。合成一位的话必然有一半是假话。
    expect(res.body.billed).toBe(false);
    expect(res.body.lost).toBe(true);
    expect(res.body.state).toBe("failed");
    // ★ 这句话必须说出口：方舟受理后失败不退费，含糊其辞等于骗人
    expect(res.body.message).toMatch(/不退/);
    expect(res.body.message).toMatch(/真人/);
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    // 凭据钉成终局：再点一次不会又去问方舟，而是原样把那句话再说一遍
    const job = await BlockoutJob().findById(started.body.jobId).lean();
    expect(job.status).toBe("failed");
    expect(job.failMessage).toMatch(/不退/);
    const again = await finish(started.body.jobId);
    expect(again.status).toBe(502);
    expect(again.body.message).toMatch(/不退/);
  });

  test("方舟受理**前** 400（敏感词/输入不合格）→ 出片那笔退回、看帧那笔不退，两笔分开说", async () => {
    // ★★ 这条钉子 2026-08-15 改过一次口径，改的原因本身就是本仓最怕的形状：
    //   它原来一边断言"余额确实少了 CHAT_TURN_TOKENS"、一边期望回包 `billed:false`。
    //   两条断言同时为真 = 测试**把"在钱上撒谎"钉成了正确行为** —— 客户端照 false
    //   会告诉用户"一分钱没动"，用户按虚高的本地余额再开一发，第二次照样被扣看帧那笔。
    //   现在的口径：**只要走过看帧那一步，billed 一律 true**，文案把两笔钱分开交代。
    net.taskAccepted = false;
    const before = await walletSvc.getWallet(owner.id);
    const res = await post(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8010` }));
    expect(res.status).toBe(502);
    expect(res.body.billed).toBe(true);
    // 两笔钱必须分别出现在同一句话里：退了的那笔 + 没退的那笔
    expect(res.body.message).toMatch(/原路退回/);
    expect(res.body.message).toMatch(/看画面.*(无法退回|不退)/);
    const after = await walletSvc.getWallet(owner.id);
    // 真实账：只掉了看帧那一次 chat 的钱（r2v 那一笔 W2 退回来了）——
    // 这正是 billed 必须为 true 的实证：余额确实少了
    expect(before.plan + before.addon - (after.plan + after.addon)).toBe(CHAT_TURN_TOKENS);
  });

  test("r2v 那一笔连发都没发出去（余额不足）→ 402 也要标 billed:true（看帧那笔已经花了）", async () => {
    // ★ 造一个"付得起看帧、付不起出片"的余额：这条路走的是 chargedArkCall 的
    //   `ok:false / reason:funds` 分支 —— 它自己那一笔一分钱没动，但看帧那笔已经花了。
    //   审查前这里回的是 billed:false，与「roles 为空」那条（同样在看帧之后）自相矛盾。
    const pid = `ideahub/template-videos/${owner.id}-8015`;
    const w = await walletSvc.getWallet(owner.id);
    // 只留下"够看一次帧、不够出片"的额度（r2v 那一笔是几十万级）
    await walletSvc.debit(owner.id, w.plan + w.addon - CHAT_TURN_TOKENS * 2, "测试：压到看帧够、出片不够");
    const res = await post(baseBody({ publicId: pid }));
    expect(res.status).toBe(402);
    expect(res.body.billed).toBe(true);
    expect(res.body.message).toMatch(/看画面.*(无法退回|不退)/);
    const after = await walletSvc.getWallet(owner.id);
    // 看帧那一笔真的扣了（这就是 billed:true 的实证）
    expect(after.plan + after.addon).toBe(CHAT_TURN_TOKENS);
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    // 恢复额度，别影响后面的用例（每个 test 共用同一个 owner 钱包）
    await walletSvc.credit(owner.id, 50_000_000, "recharge", "测试用例后复原");
  });

  test("★ 产物转存失败 → 模板**不落库**，但凭据留着：**再取一次就成**（拆两阶段换来的活路）", async () => {
    const pid = `ideahub/template-videos/${owner.id}-8011`;
    const started = await post(baseBody({ publicId: pid }));
    expect(started.status).toBe(202);
    // 第一次转存挂掉（Cloudinary 抖一下）
    uploadSpy.mockRejectedValueOnce({ error: { message: "cloudinary down" } });
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(502);
    // ★★ 拆之前这条是**终局**（"费用无法退回，请重来一次" = 让他再花一笔钱）。
    //   现在产物还在方舟那边（24h 内）、凭据也还在 —— 话必须说成"可以再来取"。
    expect(res.body.billed).toBe(false);
    expect(res.body.lost).toBeUndefined(); // 钱没白花：东西还取得回来
    expect(res.body.state).toBe("retry");
    expect(res.body.message).toMatch(/转存/);
    expect(res.body.message).toMatch(/再来取/);
    // 模板不落库（那种模板明天就是死链，且零症状）
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    // 凭据放回可取状态 —— 不放开的话用户要罚站到认领超时，而他什么错都没犯
    expect((await BlockoutJob().findById(started.body.jobId).lean()).status).toBe("pending");

    // 再取一次：这一发的结果一点没丢
    const again = await finish(started.body.jobId);
    expect(again.status).toBe(201);
    expect(again.body.template.refVideo.url).toBe(lastUpload.secure_url);
  });

  test("转存回来的产物自己过不了参考视频窗口 → 拒 + 回收产物，不落库（**确定性失败，钉成终局**）", async () => {
    uploadSpy.mockImplementation(async (_url, opts) => ({
      public_id: `${opts.folder}/${opts.public_id}`,
      secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
      duration: 2, // < 4s：拿它当下一发的参考视频必然被方舟拒
      width: 900,
      height: 512,
      bytes: 1_000,
    }));
    const pid = `ideahub/template-videos/${owner.id}-8012`;
    const started = await post(baseBody({ publicId: pid }));
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(502);
    // ★ 与"转存抖了一下"不同：再取一百次也是同一段 2 秒产物 —— 所以是 failed 不是 retry，
    //   而且要明说钱挽不回来。写成 retry 的话用户会一直点，一直失败，一直不知道为什么。
    expect(res.body.state).toBe("failed");
    expect(res.body.lost).toBe(true);
    expect(destroySpy).toHaveBeenCalled(); // 不回收就是永久占配额，零症状
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    expect((await BlockoutJob().findById(started.body.jobId).lean()).status).toBe("failed");
  });

  // ── ★★★ 产物验收：本次事故的可执行定义（2026-08-16）────────────────────
  //
  // 背景（都是实测，不是假设）：方舟 edit 的**产出比输入短** ——
  //   4.0s → 3.712s、5.0s → 4.736s、14.04s → 13.67s。
  // 而方舟自己要求输入 ∈ [4,30]。合起来就是：**用 4 秒素材做出来的模板是 3.712 秒，
  // 低于方舟自己的下限，谁都套用不了**。线上 6 个模板有 3 个是这个状态。
  //
  // 这道门在代码里一直"存在"，只是被 `Math.round(3.712) === 4` 喂了假数。
  // 下面这两条就是它的可执行定义：在修复之前，第一条必然失败。
  test("★★ 产物只有 3.712 秒（4 秒素材的真实产出）→ 取件那一步照实拒，不留一颗可发布的哑弹", async () => {
    uploadSpy.mockImplementation(async (_url, opts) => ({
      public_id: `${opts.folder}/${opts.public_id}`,
      secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
      duration: 3.712, // ← 老代码在这里 Math.round 成 4，于是坏模板一路绿灯落库
      width: 900,
      height: 512,
      bytes: 1_000_000,
    }));
    const pid = `ideahub/template-videos/${owner.id}-8031`;
    const started = await post(baseBody({ publicId: pid, durSec: 5, startSec: 0 }));
    expect(started.status).toBe(202);
    const res = await finish(started.body.jobId);

    expect(res.status).toBe(502);
    expect(res.body.state).toBe("failed"); // 确定性失败：再取一百次也是同一段产物
    expect(res.body.lost).toBe(true);
    // ★ 整句人话，且必须说到三件事：产出多短、钱回不来、下次怎么做（至少框 5 秒）
    expect(res.body.message).toMatch(/约 3\.7 秒/);
    expect(res.body.message).toMatch(/4 秒下限/);
    expect(res.body.message).toMatch(/费用已经产生/);
    expect(res.body.message).toMatch(/5 秒/);
    // ★★ **绝不落库**：落一个建成但发不出去的模板，作者只会对着"请先成功出一段片"
    //   反复撞方舟的英文 400，而那不是真正的原因。
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    expect(destroySpy).toHaveBeenCalled(); // 不合格产物要回收，不然永久占配额（零症状）
    expect((await BlockoutJob().findById(started.body.jobId).lean()).status).toBe("failed");
  });

  test("★★ 产物 4.736 秒（5 秒素材的真实产出）→ 照常建成，锚点 ceil 成 5、真值如实存下", async () => {
    // ★★★ 这一条与上一条是**一对**：只钉"坏的拒掉"是不够的 —— 把产物窗口顺手抬到 5
    //   （"给裁短量留余量"这种想当然的改法）会把唯一正确的用法也封死，而上一条照样绿。
    uploadSpy.mockImplementation(async (_url, opts) => ({
      public_id: `${opts.folder}/${opts.public_id}`,
      secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
      duration: 4.736,
      width: 900,
      height: 512,
      bytes: 1_000_000,
    }));
    const pid = `ideahub/template-videos/${owner.id}-8032`;
    const started = await post(baseBody({ publicId: pid, durSec: 5, startSec: 0 }));
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(201);
    // ceil(4.736) = 5：与 round 在这个样本上同为 5，但 ceil 把误差**永久钉在安全一侧**
    //（round 会把真实 12.4 存成 12，我们按 24s 收、方舟按 ~24.5s 计 —— 报价 < 实收）
    expect(res.body.template.refVideo).toMatchObject({ durationSec: 5, realDurationSec: 4.736 });
  });

  test("★ 不变量：落库的 durationSec 恒为 [4,30] 内的整数（「报价 = 实收」仍然成立的全部论证）", async () => {
    // ★★ 服务端的 r2vTokens 是 round + clamp[4,30]，App 的报价镜像**不 round 不 clamp**。
    //   两者恒等的充要条件就是这一条不变量。它一旦破了（比如有人把 realDurationSec 直接
    //   拿去当锚点），页面报 449,004、钱包扣 483,840 —— 两个方向都不报错。
    for (const [real, wantAnchor] of [[4.0, 4], [4.736, 5], [7.712, 8], [29.2, 30]]) {
      uploadSpy.mockImplementation(async (_url, opts) => ({
        public_id: `${opts.folder}/${opts.public_id}`,
        secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
        duration: real,
        width: 900,
        height: 512,
        bytes: 1_000_000,
      }));
      const started = await post(baseBody({ durSec: 30, startSec: 0 }));
      const res = await finish(started.body.jobId);
      expect(res.status).toBe(201);
      const anchor = res.body.template.refVideo.durationSec;
      expect({ real, anchor }).toEqual({ real, anchor: wantAnchor });
      expect(Number.isInteger(anchor)).toBe(true);
      expect(anchor).toBeGreaterThanOrEqual(4);
      expect(anchor).toBeLessThanOrEqual(30);
      // 服务端计价那一步的 round+clamp 对这个数是**恒等操作** —— 这就是两仓相等的理由
      expect(Math.max(4, Math.min(30, Math.round(anchor)))).toBe(anchor);
    }
  });

  test("★ 回执缺 duration → 走 Admin API 兜底重读；兜底也拿不到 → 终局 + 整句说明", async () => {
    // ★ 主源是 Upload API 回执（它对视频**本来就带 duration 且是小数**，
    //   `media_metadata: true` 是 Admin API 专用的补丁，这条路不需要）。
    //   回执万一缺了，用产物的 public_id 重读一次 —— 只在异常路径发一次，
    //   不吃免费档 Admin API 500 次/小时的额度。
    uploadSpy.mockImplementation(async (_url, opts) => ({
      public_id: `${opts.folder}/${opts.public_id}`,
      secure_url: `${CLOUD_PREFIX}/${opts.folder}/${opts.public_id}.mp4`,
      // duration 缺失
      width: 900,
      height: 512,
      bytes: 1_000_000,
    }));
    // ① 兜底读得到 → 照常建成（且用的是兜底那个真值）
    const outPid = () => resourceSpy.mock.calls.map((c) => c[0]).slice(-1)[0];
    resourceSpy.mockImplementation(async (publicId) =>
      publicId.includes("-out")
        ? { public_id: publicId, duration: 6.4, width: 900, height: 512, bytes: 1_000_000 }
        : { public_id: publicId, secure_url: `${CLOUD_PREFIX}/${publicId}.mp4`, duration: 60, width: 1920, height: 1080, bytes: 30_000_000, version: 1712000000 },
    );
    const okStarted = await post(baseBody({ durSec: 8, startSec: 0 }));
    // 产物 public_id 由凭据在阶段一定死；这里把它改成带 -out 的，好让上面的 mock 认出来
    await BlockoutJob().updateOne({ _id: okStarted.body.jobId }, { $set: { outPublicId: `${owner.id}-out-1` } });
    const okRes = await finish(okStarted.body.jobId);
    expect(okRes.status).toBe(201);
    expect(okRes.body.template.refVideo).toMatchObject({ durationSec: 7, realDurationSec: 6.4 });
    expect(outPid()).toContain("-out-1"); // 兜底真的发生了（Admin API 被问了产物那一条）

    // ② 兜底也拿不到 → **终局**（元数据是计价锚点，缺了就没法定价，重取一百次也一样）
    resourceSpy.mockImplementation(async (publicId) =>
      publicId.includes("-out")
        ? { public_id: publicId, width: 900, height: 512, bytes: 1_000_000 }
        : { public_id: publicId, secure_url: `${CLOUD_PREFIX}/${publicId}.mp4`, duration: 60, width: 1920, height: 1080, bytes: 30_000_000, version: 1712000000 },
    );
    const badStarted = await post(baseBody({ durSec: 8, startSec: 0 }));
    await BlockoutJob().updateOne({ _id: badStarted.body.jobId }, { $set: { outPublicId: `${owner.id}-out-2` } });
    const badRes = await finish(badStarted.body.jobId);
    expect(badRes.status).toBe(502);
    expect(badRes.body.state).toBe("failed");
    expect(badRes.body.lost).toBe(true);
    expect(badRes.body.message).toMatch(/没有返回/);
    expect(badRes.body.message).toMatch(/费用已经产生/);
    expect((await BlockoutJob().findById(badStarted.body.jobId).lean()).status).toBe("failed");
  });

  // ── 钱的门禁前置 ────────────────────────────────────────────────────
  test("免费套餐 → 403 PLAN_REQUIRED，且排在任何一次付费调用之前", async () => {
    // ★ 顺序写反的话：免费用户会先被扣掉看帧那 400 token，然后在 r2v 那一步撞 403，
    //   而他看到的错误与真正的原因对不上（"这一档不对你开放"被盖住）。
    const res = await post(baseBody({ publicId: `ideahub/template-videos/${other.id}-8013` }), asOther);
    // 归属先挡（other 的 publicId 对 other 是合法的）—— 这里用 other 自己的 id
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PLAN_REQUIRED");
    expect(res.body.billed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("未登录 → 401（这条链路每一发都真花钱，不许裸奔）", async () => {
    const res = await request(app).post("/api/branch/templates/blockoutize").send(baseBody());
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("取回结果与待取回列表同样不许裸奔 → 401", async () => {
    expect((await request(app).post("/api/branch/templates/blockoutize/finish").send({ jobId: "x" })).status).toBe(401);
    expect((await request(app).get("/api/branch/templates/blockoutize/pending")).status).toBe(401);
  });

  // ── 级联回收 ────────────────────────────────────────────────────────
  test("删模板时连原始素材一起回收（不然每做一个模板就永久漏一份原片）", async () => {
    const { finished: made } = await run(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8014` }));
    expect(made.status).toBe(201);
    const refPublicId = lastUpload.public_id;
    destroySpy.mockClear();
    await request(app).delete(`/api/branch/templates/${made.body.template.id}`).set(asOwner()).expect(200);
    const destroyed = destroySpy.mock.calls.map((c) => c[0]);
    expect(destroyed).toContain(refPublicId); // 参考视频本体
    expect(destroyed).toContain(`ideahub/template-videos/${owner.id}-8014`); // 原始素材
  });

  test("模板还在时，孤儿口不许删它的原始素材（否则再也重做不了）", async () => {
    const { finished: made } = await run(baseBody({ publicId: `ideahub/template-videos/${owner.id}-8015` }));
    expect(made.status).toBe(201);
    destroySpy.mockClear();
    const res = await request(app)
      .delete("/api/uploads/template-video")
      .set(asOwner())
      .send({ publicId: `ideahub/template-videos/${owner.id}-8015` });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/原始素材/);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  test("★ 还没取回结果时，孤儿口也不许删原始素材（删了那一发就白花钱且没人会说）", async () => {
    // ★★ 从受理到取回之间世上还没有模板，前两道 exists 都落空 —— 而方舟可能还要去拉
    //   这段素材的变换地址（懒生成）。此刻删掉它，用户那一发会莫名其妙失败，**钱已经花了**。
    const pid = `ideahub/template-videos/${owner.id}-8018`;
    expect((await post(baseBody({ publicId: pid }))).status).toBe(202);
    destroySpy.mockClear();
    const res = await request(app).delete("/api/uploads/template-video").set(asOwner()).send({ publicId: pid });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/白模化|取回/);
    expect(destroySpy).not.toHaveBeenCalled();
  });

  // ══ 两阶段特有的四道闸 ═══════════════════════════════════════════════

  test("★ 幂等：连调两次 finish 只出**一个**模板（第二次回同一个，不是 500、不是第二份）", async () => {
    // ★★ 只靠 refVideo.url 的唯一索引是**不够的**：每次转存都是一次新的 Cloudinary 上传，
    //   secure_url 里带着新的 version —— 两条 URL 并不相等，索引根本不会撞。
    //   所以"一张取件单只许建一个模板"必须由 BranchTemplate.blockoutJobId 的唯一索引兜底。
    const pid = `ideahub/template-videos/${owner.id}-8019`;
    const started = await post(baseBody({ publicId: pid }));
    const first = await finish(started.body.jobId);
    expect(first.status).toBe(201);
    const second = await finish(started.body.jobId);
    expect(second.status).toBe(200); // 已经取回过了：回既有那一个
    expect(second.body.ok).toBe(true);
    expect(second.body.state).toBe("done");
    expect(second.body.template.id).toBe(first.body.template.id);
    expect(await BranchTemplate().countDocuments({ "source.publicId": pid })).toBe(1);
    expect(await BranchTemplate().countDocuments({ blockoutJobId: started.body.jobId })).toBe(1);
  });

  test("★ 幂等（并发）：两发 finish 同时打进来，也只出一个模板", async () => {
    const pid = `ideahub/template-videos/${owner.id}-8020`;
    const started = await post(baseBody({ publicId: pid }));
    const [a, b] = await Promise.all([finish(started.body.jobId), finish(started.body.jobId)]);
    // 一发建成（201），另一发要么被认领挡住（202 working）、要么撞唯一索引后回既有那条（200）——
    // 三种都行，**唯独不许**建出第二个模板
    const codes = [a.status, b.status].sort();
    expect(codes).toContain(201);
    expect(await BranchTemplate().countDocuments({ "source.publicId": pid })).toBe(1);
  });

  test("★ 归属：别人拿到 jobId 也取不走（404 而不是 403 —— 403 等于承认它存在）", async () => {
    const pid = `ideahub/template-videos/${owner.id}-8021`;
    const started = await post(baseBody({ publicId: pid }));
    const stolen = await finish(started.body.jobId, asOther);
    expect(stolen.status).toBe(404);
    expect(typeof stolen.body.message).toBe("string");
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    // 本人还取得回来（没被那一发弄坏）
    expect((await finish(started.body.jobId)).status).toBe(201);
  });

  test("★ 过期（24h）→ 410 整句：说清楚「产物已过期、这一发的费用无法挽回」", async () => {
    const pid = `ideahub/template-videos/${owner.id}-8022`;
    const started = await post(baseBody({ publicId: pid }));
    // 把死期拨到过去（方舟产物是 TOS 签名地址、24h 过期，F12）
    await BlockoutJob().updateOne({ _id: started.body.jobId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(410);
    expect(res.body.state).toBe("expired");
    expect(res.body.billed).toBe(false); // 这一次调用没花钱
    expect(res.body.lost).toBe(true); // 但开炼那一笔什么都没剩
    // ★ 话要说满：只说"已过期"会让用户以为再开一发就好了（然后又扣一次钱）
    expect(res.body.message).toMatch(/过期/);
    expect(res.body.message).toMatch(/24 小时/);
    expect(res.body.message).toMatch(/无法挽回/);
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    expect((await BlockoutJob().findById(started.body.jobId).lean()).status).toBe("expired");
  });

  test("★ 任务还在跑 → 202 + 整句「还没出片，稍后再来取」，**不是报错**、凭据仍可取", async () => {
    // ★ 回 4xx/5xx 的话，App 会把一发**好端端在跑**的生成显示成失败，用户以为钱白花了
    net.taskStatus = "running";
    const pid = `ideahub/template-videos/${owner.id}-8023`;
    const started = await post(baseBody({ publicId: pid }));
    const res = await finish(started.body.jobId);
    expect(res.status).toBe(202);
    expect(res.body.state).toBe("running");
    expect(res.body.billed).toBe(false);
    expect(res.body.lost).toBeUndefined();
    expect(res.body.message).toMatch(/还没出片/);
    expect(res.body.message).toMatch(/再来|取回/);
    expect(res.body.remainingSec).toBeGreaterThan(0);
    expect(await BranchTemplate().findOne({ "source.publicId": pid }).lean()).toBeNull();
    // 凭据放回可取：出片之后再点一次就成（不放开的话他要罚站到认领超时）
    expect((await BlockoutJob().findById(started.body.jobId).lean()).status).toBe("pending");
    net.taskStatus = "succeeded";
    expect((await finish(started.body.jobId)).status).toBe(201);
  });

  test("★ finish **不收**客户端重报的任何数（重报 = 让他改价改内容）", async () => {
    // ★★ durSec 是 r2v 的计价输入时长、roles 是套用者挂卡的唯一依据。
    //   finish 要是收这些，就等于"开炼按 8 秒报价、取件时改成 30 秒"、
    //   "AI 认出的是甲乙，落库时换成丙丁" —— 两件都不会报错。
    const pid = `ideahub/template-videos/${owner.id}-8024`;
    const started = await post(baseBody({ publicId: pid }));
    const res = await finish(started.body.jobId, asOwner, {
      durSec: 30,
      title: "偷偷改掉的标题",
      roles: [{ label: "9", desc: "客户端自己编的" }],
      publicId: `ideahub/template-videos/${other.id}-1`,
      taskId: "cgt-别人的任务",
      status: "succeeded",
    });
    expect(res.status).toBe(201);
    const doc = await BranchTemplate().findById(res.body.template.id).lean();
    expect(doc.title).toBe("白模跑酷 V2"); // 凭据里那份
    expect(doc.source.durSec).toBe(8); // 不是客户端报的 30
    expect(doc.source.publicId).toBe(pid); // 不是别人的素材
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "2"]); // 视觉那一步的清单
  });

  test("jobId 是编的 / 形状不对 → 404 整句（不泄露任何凭据的存在性）", async () => {
    for (const bad of ["not-an-id", new mongoose.Types.ObjectId().toString()]) {
      const res = await finish(bad);
      expect(res.status).toBe(404);
      expect(typeof res.body.message).toBe("string");
    }
  });

  // ── 掉线兜底：待取回列表（不做这条，两阶段就白拆了）──────────────────
  describe("GET /api/branch/templates/blockoutize/pending", () => {
    const listOf = (who = asOwner) => request(app).get("/api/branch/templates/blockoutize/pending").set(who());

    test("★ 列出还没取回的那些，带剩余时间与整句说明；取回之后就不再出现", async () => {
      const pid = `ideahub/template-videos/${owner.id}-8025`;
      const started = await post(baseBody({ publicId: pid, title: "掉线也找得回来" }));
      const list = await listOf();
      expect(list.status).toBe(200);
      const row = list.body.jobs.find((j) => j.jobId === started.body.jobId);
      expect(row).toBeTruthy();
      expect(row.state).toBe("pending");
      expect(row.canFinish).toBe(true);
      expect(row.title).toBe("掉线也找得回来");
      expect(row.taskId).toBe(started.body.taskId); // App 拿它接着轮询
      expect(row.durSec).toBe(8);
      expect(row.roles.map((r) => r.label)).toEqual(["1", "2"]);
      expect(row.remainingSec).toBeGreaterThan(23 * 3600);
      expect(typeof row.remainingText).toBe("string");
      expect(row.message).toMatch(/24 小时|过期/); // 别让用户以为随时能回来取

      expect((await finish(started.body.jobId)).status).toBe(201);
      const after = await listOf();
      expect(after.body.jobs.map((j) => j.jobId)).not.toContain(started.body.jobId);
    });

    test("★ 过期的**要留在列表里**并整句说明，而不是悄悄消失", async () => {
      // ★★ 直接从列表消失的话，用户只会以为是我们把他的东西弄丢了 ——
      //   而事实是"产物过期了、这笔钱没了"，这句话必须有人说（铁律八）。
      const pid = `ideahub/template-videos/${owner.id}-8026`;
      const started = await post(baseBody({ publicId: pid }));
      await BlockoutJob().updateOne({ _id: started.body.jobId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const row = (await listOf()).body.jobs.find((j) => j.jobId === started.body.jobId);
      expect(row.state).toBe("expired");
      expect(row.canFinish).toBe(false);
      expect(row.remainingSec).toBe(0);
      expect(row.message).toMatch(/过期/);
      expect(row.message).toMatch(/无法挽回/);
    });

    test("只看得见自己的（别人的凭据一条都不出）", async () => {
      const pid = `ideahub/template-videos/${owner.id}-8027`;
      const started = await post(baseBody({ publicId: pid }));
      const mine = (await listOf()).body.jobs.map((j) => j.jobId);
      expect(mine).toContain(started.body.jobId);
      const theirs = (await listOf(asOther)).body.jobs.map((j) => j.jobId);
      expect(theirs).not.toContain(started.body.jobId);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("存量坏模板的两道门（发布闸 / 套用闸）—— 说的是真正的原因", () => {
  // ★★ 线上那 3 个模板（refVideo.durationSec = 4、真实 3.712s）的处境：
  //   作者反复试炼、反复撞方舟的英文 400，于是 provenAt 永远为空 ——
  //   他撞上的是试炼闸那句「请先成功出一段片」，**而那不是真正的原因**。
  //   这一组钉的就是"拒绝的理由指对方向"，以及**存量老模板不被误判**（判否定）。
  const BranchTemplate = () => require("../src/models/BranchTemplate");

  /** 给一个已建好的模板落上真实时长（模拟回填脚本跑完之后的样子） */
  async function setReal(id, realSec) {
    await BranchTemplate().updateOne({ _id: id }, { $set: { "refVideo.realDurationSec": realSec } });
  }

  test("★ 回填出真实时长 3.712s 的坏模板：发布闸拒，且理由是时长不是试炼", async () => {
    const tpl = await createTemplate(6501);
    // 试炼闸先满足，把时长这道门单独露出来（不这么做的话两道门的拒绝分不开）
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date() } });
    await setReal(tpl.id, 3.712);
    const res = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/约 3\.7 秒/);
    expect(res.body.message).toMatch(/4 秒下限/);
    expect(res.body.message).toMatch(/每一个套用它的人都会失败/);
    expect(res.body.message).not.toMatch(/先用这个模板成功出一段片/); // 指错方向的那句
    expect((await BranchTemplate().findById(tpl.id).lean()).status).toBe("pending");
  });

  test("★★ 存量老模板（**没有** realDurationSec 这一位）照常发布 —— 后加的字段判否定", async () => {
    // ★★ 这条防的是"用肯定式判新字段"：`realDurationSec >= 4` 之类的写法会把所有
    //   存量模板（那一位是 undefined）整批判成坏的 —— 老模板突然发布不了了，且不报错。
    const tpl = await createTemplate(6502);
    // $unset 造出真正的"存量形状"：这一位是 2026-08-16 才加的，之前建的模板都没有它
    await BranchTemplate().updateOne(
      { _id: tpl.id },
      { $set: { provenAt: new Date() }, $unset: { "refVideo.realDurationSec": "" } },
    );
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.refVideo.realDurationSec).toBeUndefined(); // 前提：它真的没有这一位
    const res = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(res.status).toBe(200);
    expect(res.body.template.status).toBe("published");
    // 响应里也不该凭空出一个 0 —— 那会让客户端把"没有这个字段"读成"真的是 0 秒"
    expect(res.body.template.refVideo.realDurationSec).toBeUndefined();
  });

  test("真实时长合格（4.736s）的模板照常发布，且真值原样出到响应里", async () => {
    const tpl = await createTemplate(6503);
    await BranchTemplate().updateOne({ _id: tpl.id }, { $set: { provenAt: new Date() } });
    await setReal(tpl.id, 4.736);
    const res = await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner());
    expect(res.status).toBe(200);
    expect(res.body.template.refVideo.realDurationSec).toBe(4.736);
    // 计价锚点一个字没动（这是已发布模板的报价，改它就是改价）
    expect(res.body.template.refVideo.durationSec).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("三套验收窗口（单元）—— 各自的唯一实现，名字必须分得开", () => {
  // ★★ 白模 V2 起窗口分成三件事，混用哪一个都不报错、只会静默出事：
  //   · templateSourceIssue —— 用户传上来的**原始素材**（[5,600]s、不校比例）
  //   · templateRefIssue    —— 真正喂给方舟的那一段 / **白模化的产物**（F1 [4,30]s + F3）
  //   · blockoutInputIssue  —— **白模化的输入**（= ref 那套，时长下限抬到 5）
  //   把 ref 那套用在上传口 = 长素材连传都传不上来；
  //   把 source 那套用在建模板 = 一段 300s 的片被登记成模板，套用者在付费那一步撞 400（不退费）；
  //   把 blockout 那套用在**产物**上 = 一段合法的 5s 输入产出 4.736s，被自己的门拒掉，
  //   等于把唯一正确的用法也封死。
  const {
    templateSourceIssue,
    templateRefIssue,
    templateRefDurationIssue,
    blockoutInputIssue,
    templateVideoMeta,
    TEMPLATE_SOURCE_RULES,
    TEMPLATE_REF_RULES,
    BLOCKOUT_INPUT_RULES,
    BLOCKOUT_MIN_INPUT_SEC,
  } = require("../src/middleware/upload");

  test("参考视频窗口：合格样本 → null", () => {
    expect(templateRefIssue({ duration: 10, width: 720, height: 1280 })).toBeNull();
    expect(templateRefIssue({ duration: 4, width: 640, height: 640 })).toBeNull(); // 409,600 ≥ 407,696
    expect(templateRefIssue({ duration: 30, width: 720, height: 1280 })).toBeNull(); // 上界含端点
  });

  test("参考视频窗口是 [4,30] 秒（F1 实测：方舟 edit 的硬窗口）—— **一个字都不许改**", () => {
    // ★★ 这条窗口是方舟自己的，不是我们的自我约束。想给"白模产出会被截短"留余量时，
    //   动这里是**致命**的：finish 那道产物闸门读的就是它，抬到 5 会把一段合法的 5s 输入
    //   产出（4.736s）判成不合格 —— 唯一正确的用法被自己封死。余量归 BLOCKOUT_INPUT_RULES。
    expect(TEMPLATE_REF_RULES.minSec).toBe(4);
    expect(TEMPLATE_REF_RULES.maxSec).toBe(30);
    expect(templateRefIssue({ duration: 3, width: 720, height: 1280 })).toMatch(/至少要 4 秒/);
    expect(templateRefIssue({ duration: 31, width: 720, height: 1280 })).toMatch(/最长 30 秒/);
    // 产物的两个真实观测值：4.736s 合格（5s 输入的正常产出）、3.712s 不合格（4s 输入的产出）
    expect(templateRefIssue({ duration: 4.736, width: 900, height: 512 })).toBeNull();
    expect(templateRefIssue({ duration: 3.712, width: 900, height: 512 })).toMatch(/至少要 4 秒/);
  });

  test("白模化**输入**窗口：下限 5，其余六条原样委托给参考视频窗口", () => {
    // 下限是这条规则**多出来的那一条**，理由：edit 的产出比输入短（实测最坏 0.37s），
    // 4 秒进去只剩 3.7 秒 —— 低于方舟自己的 4 秒下限，谁都套用不了。
    expect(BLOCKOUT_MIN_INPUT_SEC).toBe(5);
    expect(BLOCKOUT_INPUT_RULES.minSec).toBe(5);
    expect(blockoutInputIssue({ duration: 4, width: 900, height: 512 })).toMatch(/至少 5 秒/);
    expect(blockoutInputIssue({ duration: 5, width: 900, height: 512 })).toBeNull();
    // ★ 其余六条**不是抄的**：上限/像素/边长/比例/元数据缺失全走 templateRefIssue 那一份。
    //   抄一份的话，哪天 F3 的像素门变了只改得动一处，而另一处没有任何症状。
    expect(BLOCKOUT_INPUT_RULES.maxSec).toBe(TEMPLATE_REF_RULES.maxSec);
    expect(BLOCKOUT_INPUT_RULES.minPixels).toBe(TEMPLATE_REF_RULES.minPixels);
    expect(blockoutInputIssue({ duration: 31, width: 900, height: 512 })).toMatch(/最长 30 秒/);
    expect(blockoutInputIssue({ duration: 10, width: 640, height: 636 })).toMatch(/分辨率太低/);
    expect(blockoutInputIssue({ duration: 10, width: 500, height: 1500 })).toMatch(/宽高比/);
    expect(blockoutInputIssue({ width: 720, height: 1280 })).toMatch(/没有返回/);
  });

  test("★ templateVideoMeta 的 duration **保留小数**（那个 Math.round 是本次事故的单点根因）", () => {
    // ★★ 取整一旦回来，`Math.round(3.712) === 4` 会让一段 3.712s 的白模产物通过
    //   `duration < 4` 那道唯一的产物闸门 —— 坏模板照建、作者付了钱、每个套用者都失败。
    //   同一行还会把 3.6s 的原片读成 4s 放行（同源的第二条活 bug）。
    expect(templateVideoMeta({ duration: 3.712, width: 900, height: 512, bytes: 1 }).duration).toBe(3.712);
    expect(templateVideoMeta({ duration: 4.736, width: 900, height: 512, bytes: 1 }).duration).toBe(4.736);
    // 像素与字节继续取整：它们天然是整数，回执给浮点只是表示问题
    expect(templateVideoMeta({ duration: 8, width: 900.4, height: 512.6, bytes: 3.2 })).toMatchObject({
      width: 900,
      height: 513,
      bytes: 3,
    });
  });

  test("★ 只判时长那一半（发布闸/套用闸用）：**缺字段一律当好**，别把存量整批误判", () => {
    // ★★ 后加的字段一律判否定：老模板没有 realDurationSec，读到 undefined/null 时
    //   必须当"无从判断 = 合格"。用肯定式判会把所有存量模板判成坏的，且不报错。
    expect(templateRefDurationIssue(undefined)).toBeNull();
    expect(templateRefDurationIssue(null)).toBeNull();
    expect(templateRefDurationIssue(NaN)).toBeNull();
    expect(templateRefDurationIssue(0)).toBeNull();
    expect(templateRefDurationIssue(10)).toBeNull();
    expect(templateRefDurationIssue(3.712, "这个模板的白模视频")).toMatch(/至少要 4 秒/);
    // 小数写进句子时留一位：印出 "约 3.7119999 秒" 的话，用户第一反应是"这系统坏了"
    expect(templateRefDurationIssue(3.712)).toMatch(/约 3\.7 秒/);
  });

  test("像素数硬门是 407,696（A2 探针实测值，改它必须两仓一起改）", () => {
    expect(TEMPLATE_REF_RULES.minPixels).toBe(407_696);
    expect(TEMPLATE_SOURCE_RULES.minPixels).toBe(407_696); // 裁剪面积 ≤ 原片面积 ⇒ 这是必要条件
    // 640×636 = 407,040 < 门；640×640 = 409,600 ≥ 门
    expect(templateRefIssue({ duration: 10, width: 640, height: 636 })).toMatch(/分辨率太低/);
    expect(templateRefIssue({ duration: 10, width: 640, height: 640 })).toBeNull();
  });

  test("参考视频窗口仍校宽高比 [0.4,2.5]（方舟官方约束）", () => {
    expect(templateRefIssue({ duration: 10, width: 500, height: 1500 })).toMatch(/宽高比/);
  });

  test("原始素材窗口：放宽了哪几项（改回去的话用户根本没法开始）", () => {
    // 时长：[5,600]。★ 上限 10 分钟只封上传成本，与方舟无关；
    //   下限 5 = BLOCKOUT_MIN_INPUT_SEC —— 裁出来的那一段不可能比原片长，
    //   所以"原片 <5s"是"框选段 <5s"的**必要条件**，在本机预检就能拦（省一次 100MB 白传）。
    expect(TEMPLATE_SOURCE_RULES.minSec).toBe(BLOCKOUT_MIN_INPUT_SEC);
    expect(templateSourceIssue({ duration: 5, width: 1920, height: 1080 })).toBeNull();
    expect(templateSourceIssue({ duration: 4.6, width: 1920, height: 1080 })).toMatch(/至少 5 秒/);
    expect(templateSourceIssue({ duration: 600, width: 1920, height: 1080 })).toBeNull();
    expect(templateSourceIssue({ duration: 601, width: 1920, height: 1080 })).toMatch(/最长 600 秒/);
    // 比例：**不校** —— 比例正是裁剪框能修的那一项
    expect(templateSourceIssue({ duration: 10, width: 500, height: 1500 })).toBeNull();
    // 边长上限：**不设** —— 4K/8K 原片没问题，裁出来那块 ≤6000 即可
    expect(templateSourceIssue({ duration: 10, width: 7680, height: 4320 })).toBeNull();
    // 但边长下限与像素门保留：它们是"裁出来那块能合格"的必要条件，早拒省一次 100MB 白传
    expect(templateSourceIssue({ duration: 10, width: 299, height: 3000 })).toMatch(/边长至少 300 像素/);
    expect(templateSourceIssue({ duration: 10, width: 640, height: 360 })).toMatch(/分辨率太低/);
  });

  test("缺元数据（回执没给 duration）→ 两套窗口都整句拒，不放行", () => {
    expect(templateSourceIssue({ width: 720, height: 1280 })).toMatch(/没有返回/);
    expect(templateSourceIssue(null)).toMatch(/没有返回/);
    expect(templateRefIssue({ width: 720, height: 1280 })).toMatch(/没有返回/);
    expect(templateRefIssue(null)).toMatch(/没有返回/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("看几帧（单元）—— visionFrameTimes 是这条规则的唯一实现", () => {
  // ★★ 这个函数同时是**报价的锚点**（App 侧 economy.blockoutizeCost 的前一半按同一条公式
  //   镜像）和**真正抽帧的依据**。两处分家的表现是"页面按 3 帧报价、服务端按 8 帧扣钱"，
  //   两个方向都不报错 —— 本仓头号事故形状。所以公式本身要在单元层面钉死。
  // ★ 走 HTTP 的那一组（「看几帧」）钉的是"真的抽了那几帧"；这一组钉的是"算得对"。
  //   两层都要：只测函数会漏掉路由忘了加 startSec，只测 HTTP 会漏掉 >8 截断这种走不到的分支。
  const blockout = require("../src/services/blockoutize.service");
  const { blockoutizeBody } = require("../src/schemas/branchTemplate.schemas");

  let warnSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  test("自动帧数 = clamp(ceil(durSec / 1.5), 3, 8)", () => {
    // 4s→3（下限兜住；写死 3 帧那一版正是在这里漏了人）、12s→8（封顶）、30s→仍 8
    expect(blockout.visionFrameTimes(4)).toHaveLength(3);
    expect(blockout.visionFrameTimes(6)).toHaveLength(4);
    expect(blockout.visionFrameTimes(8)).toHaveLength(6);
    expect(blockout.visionFrameTimes(12)).toHaveLength(8);
    expect(blockout.visionFrameTimes(30)).toHaveLength(8);
    expect(blockout.VISION_FRAMES_MIN).toBe(3);
    expect(blockout.VISION_FRAMES_MAX).toBe(8);
    expect(blockout.VISION_SEC_PER_FRAME).toBe(1.5);
  });

  test("自动取的时刻：升序、去重、落在 [0, durSec)、取整到 0.5 秒", () => {
    // ★ 不取整的话会拼出 so_2.6666666666666665 —— 拿不到 CDN 缓存，去重也永远去不掉
    expect(blockout.visionFrameTimes(4)).toEqual([0, 1.5, 2.5]);
    expect(blockout.visionFrameTimes(12)).toEqual([0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5]);
    for (const dur of [4, 5, 7, 11, 17, 23, 30]) {
      const t = blockout.visionFrameTimes(dur);
      expect([...t].sort((a, b) => a - b)).toEqual(t);
      expect(new Set(t).size).toBe(t.length);
      for (const v of t) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(dur); // 右端是开的：durSec 那一刻已经不在这一段里
        expect(v * 2).toBe(Math.round(v * 2)); // 0.5 的整数倍
      }
    }
  });

  test("自选：原样用（去重 + 排序 + 取整），不擅自加帧也不擅自减帧", () => {
    expect(blockout.visionFrameTimes(8, [3, 1, 3, 6.4])).toEqual([1, 3, 6.5]);
  });

  test("★ 自选越界：丢掉那一个并 console.warn，其余照用（不整条拒）", () => {
    // ★ 整条拒 = 用户已经付过上传与框选的时间成本，为一个坏数把他打回起点。
    //   但丢弃必须**响亮**（铁律八）：静默丢的话，"我标了 5 帧怎么只看了 3 帧"永远查不出来。
    expect(blockout.visionFrameTimes(8, [1, 8, 20, -3])).toEqual([1]);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/不在 \[0, 8\) 内，已丢弃/);
  });

  test("★ 自选超过 8 个 → 截断到 8（函数这一层的最后兜底，与 schema 共用同一个上限常量）", () => {
    // ★★ 上限只能有一处：schema 的数组上限就是从 blockout.VISION_FRAMES_MAX import 的。
    //   在两边各写一个 8 就是 CLAUDE.md「最多出几张卡的上限自己抄一份」那条坑 ——
    //   改上限时改一处漏一处**没有任何症状**，只会变成报价与实收不等。
    const picked = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(blockout.visionFrameTimes(20, picked)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/超过上限 8/);
    // schema 的上限与它是同一个数（谁改了另一边都会红）
    expect(blockoutizeBody.safeParse({ ...unitBody(), frameTimes: picked }).success).toBe(false);
    expect(blockoutizeBody.safeParse({ ...unitBody(), frameTimes: picked.slice(0, 8) }).success).toBe(true);
  });

  test("自选全被丢光 / 空数组 → 退回自动，**绝不返回空**", () => {
    // ★ 返回空 → 一帧都不抽 → 视觉认不出人 → 在 roles 为空那里被拒，
    //   而用户看到的理由是"AI 没认出人"，与真正原因（他标的时刻全越界）完全对不上。
    expect(blockout.visionFrameTimes(8, [])).toHaveLength(6);
    expect(blockout.visionFrameTimes(8, [8, 99])).toHaveLength(6);
    expect(blockout.visionFrameTimes(8, [NaN])).toHaveLength(6);
  });

  test("durSec 本身坏了 → 退单帧并 console.warn（上游漏了一道校验，不许静默）", () => {
    expect(blockout.visionFrameTimes(0)).toEqual([0]);
    expect(blockout.visionFrameTimes(undefined)).toEqual([0]);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("★ frameTimes 在 schema 里**显式声明**了（不声明就被 zod strip，全程零报错）", () => {
    const parsed = blockoutizeBody.parse({ ...unitBody(), frameTimes: [0, 2.5] });
    expect(parsed.frameTimes).toEqual([0, 2.5]);
    // 不传就是"自动模式"：不给默认值，判据一律用存在性
    expect(blockoutizeBody.parse(unitBody()).frameTimes).toBeUndefined();
    // 形状上不可能对的一律拒（负数 / 非数 / 超 600s）
    for (const bad of [[-1], ["2"], [601], [Infinity], [NaN]]) {
      expect(blockoutizeBody.safeParse({ ...unitBody(), frameTimes: bad }).success).toBe(false);
    }
  });

  /** schema 单测用的最小合法 body（四组数的真正验收在路由里，这里只要过得了形状） */
  function unitBody() {
    return {
      publicId: "ideahub/template-videos/abc-1",
      startSec: 0,
      durSec: 8,
      crop: { x: 0, y: 0, w: 900, h: 512 },
      title: "t",
    };
  }
});

// ─────────────────────────────────────────────────────────────────────
describe("角色位上限（单元）—— BLOCKOUT_ROLE_MAX 是这条规则的唯一实现", () => {
  // ★★ 这个数有三个消费方（parseRoles 的截断、提示词里的"编到 N"、schema 的数组上限），
  //   任何一处自己抄一份都**没有症状**：只会变成"白模化登记 9 格、作者能核对成 12 格"，
  //   多出来那几格挂的卡在出片时因为参考图预算超了被悄悄丢掉 —— 钱照扣、零报错
  //   （CLAUDE.md「最多出几张卡的上限自己抄一份」那条坑的同族）。
  const blockout = require("../src/services/blockoutize.service");
  const { patchRolesBody } = require("../src/schemas/branchTemplate.schemas");

  let warnSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  /** 造 n 行视觉清单（就是 chat vision 那一步吐出来的形状） */
  const visionLines = (n) => Array.from({ length: n }, (_, i) => `${i + 1}|位置${i + 1}|第 ${i + 1} 个人`).join("\n");

  test("上限是 9，且 schema 的数组上限就是同一个数（谁改了另一边都会红）", () => {
    // ★ 9 的来历：上界是参考图预算（9 × 每张人物卡 2~3 张图 = 18~27 ≤ 方舟 2.5 的 30 张），
    //   下界是人眼（实测 12 个时编号印得出来，但画面上能稳定认出的只有 4~5 个）。
    expect(blockout.BLOCKOUT_ROLE_MAX).toBe(9);
    const many = (n) => Array.from({ length: n }, (_, i) => ({ label: String(i + 1), desc: `第 ${i + 1} 个` }));
    expect(patchRolesBody.safeParse({ roles: many(blockout.BLOCKOUT_ROLE_MAX) }).success).toBe(true);
    expect(patchRolesBody.safeParse({ roles: many(blockout.BLOCKOUT_ROLE_MAX + 1) }).success).toBe(false);
  });

  test("★ 认出 12 个 → 截断到 9，且截断发生在**编号之前**（label 恒为连续的 1..9）", () => {
    const roles = blockout.parseRoles(visionLines(12));
    expect(roles).toHaveLength(9);
    expect(roles.map((r) => r.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    // 留下的是**最靠前的** 9 个（视觉清单按画面主次列，靠前的更可能是真主角）
    expect(roles[8].desc).toContain("第 9 个");
    // ★★ 而"靠前 = 戏份重"这件事必须由**视觉提示词**保证，否则截断就是在赌运气：
    //   模型若按从左到右或入场先后列，被截掉的可能正是主角，且零报错。
    expect(blockout.visionPrompt()).toMatch(/按重要程度从高到低排列/);
    expect(roles.every((r) => r.labelConfirmed === false)).toBe(true);
  });

  test("★ 丢掉的那几个要**响亮**记一笔（静默丢 = 没人知道画面里第 10 个人去哪了）", () => {
    blockout.parseRoles(visionLines(12));
    expect(warnSpy).toHaveBeenCalled();
    const said = warnSpy.mock.calls.flat().join(" ");
    expect(said).toMatch(/认出 12 个人物/);
    expect(said).toMatch(/上限 9/);
    // 说清楚被丢掉的人**没有消失**：提示词里"清单之外的人照样白模化但不编号"管着他们
    expect(said).toMatch(/不给编号/);
  });

  test("没超上限时不警告（别把正常那一路也吵成噪音，否则真出事时没人看日志）", () => {
    expect(blockout.parseRoles(visionLines(9))).toHaveLength(9);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("★ 提示词里那个 N 跟着**截断后**的个数走（说 12 而只印 9 个号 = 画面上凭空多出三个号）", () => {
    const text = blockout.blockoutPrompt(blockout.parseRoles(visionLines(12)));
    expect(text).toMatch(/共 9 人/);
    expect(text).toMatch(/只用 1 到 9/);
    expect(text).not.toContain("第 10 个");
    // 点名段是**一人一行的短句**（`编号=原来的样子`）：9 个人时长串会把要害那几句挤到尾巴上
    expect(text).toContain("\n1=位置1，第 1 个人\n");
    expect(text).toContain("\n9=位置9，第 9 个人\n");
  });

  test("★ 点名段的描述切到 60 字，**落库那份不动**（两者不是同一条规则）", () => {
    // ★★ 落库那份是给**人**读的（套用者挂卡只看它，作者还能改写），提示词那份是给
    //   **模型**认人用的。不切的话，模型某一发多话吐 9 条 300 字描述，点名段两千多字，
    //   把后面那几句要害（编号印哪儿、编到几、清单外不编号）稀释到读不出来 ——
    //   而结果只是"编号又乱了"，没有任何一层会报错。
    const long = "甲".repeat(400);
    const roles = blockout.parseRoles(`1|${long}`);
    expect(roles[0].desc).toHaveLength(300); // 落库上限（与 mongoose roleSchema 的 300 对齐）
    const text = blockout.blockoutPrompt(roles);
    expect(text).toContain(`1=${"甲".repeat(60)}\n`);
    expect(text).not.toContain("甲".repeat(61));
  });

  test("★ 头部四面 + 同一个数字 + 清单外不编号 —— 三句都在（少一句就有一种挂错卡的路子）", () => {
    const text = blockout.blockoutPrompt(blockout.parseRoles(visionLines(2)));
    // ① 四面：胸口那个一转身就看不见，而编号是挂卡的唯一连接键
    expect(text).toMatch(/头部前后左右四面/);
    // ② 同一个：不说死的话，同一个人偶四面印四个不同的号，比印在胸口还糟
    expect(text).toMatch(/同一个/);
    // ②' 号**从清单抄**，不让模型自己编（自己编实测出 2/2/1/1/5，重号又漏号）
    expect(text).toMatch(/清单写几号的那个人，他的人偶头上就印几号/);
    // ③ 清单外的人白模化但不编号：画面上多一个列表里没有的号 = 一句我们兑现不了的承诺
    expect(text).toMatch(/清单之外若还出现别的人物/);
    expect(text).toMatch(/不给编号/);
    expect(text).toMatch(/头上身上保持空白/);
    // ④ F4 的要害（"包括…在内" + 主角那一句）没被这次压缩措辞带走
    expect(text).toContain("包括");
    expect(text).toMatch(/看起来像主角的那一个/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("★ 删角色位：整份替换里「少给一条」就是删除（白模 V2）", () => {
  // ★★ 2026-08-15 实测：方舟画编号并不可靠。同一段 5 人素材实出过
  //     2/2/1/1/5（两组重号，3 和 4 整个没出现）与 3/1/1/4/5（一组重号，2 没出现）。
  //   而落库那份 label 是服务端自己编的**连续** 1..N —— 所以库里永远不会有两个「1」，
  //   **重号只发生在画面上**。作者面对的真实局面是："可寻址的号"比登记的号少，
  //   他必须把找得到的号改对，把**画面上根本找不到的那几个位子删掉**（5 个位退成 3~4 个）。
  //   没有这条路，他唯一的出路是再花一次钱重炼整段。
  //
  // ★★ 这一组同时钉住三件"拆掉也不报错"的事：
  //   ① 剩下的 label **逐字不动**（数组相等而不是集合相等 —— 集合相等漏得掉重排）；
  //   ② "改号 + 删位"必须**一次提交**（分两步必撞重号闸，所以不该有 DELETE 端点）；
  //   ③ 下限是 1 不是 0，且撞上它时说的是**人话**（不是 zod 的英文 Validation error）。
  const BranchTemplate = () => require("../src/models/BranchTemplate");

  /** 白模化落库那一刻的样子：label 恒为服务端编的**连续** 1..N，全部未核对 */
  const guessed = (n) =>
    Array.from({ length: n }, (_, i) => ({ label: String(i + 1), desc: `第 ${i + 1} 个人` }));

  async function v2Template(ts, { roles = guessed(3), proven = true } = {}) {
    const tpl = await createTemplate(ts);
    await BranchTemplate().updateOne(
      { _id: tpl.id },
      { $set: { roles, ...(proven ? { provenAt: new Date() } : {}) } },
    );
    return tpl;
  }

  const patchRoles = (id, roles, who = asOwner) =>
    request(app).patch(`/api/branch/templates/${id}/roles`).set(who()).send({ roles });

  const labelsIn = async (id) => (await BranchTemplate().findById(id).lean()).roles.map((r) => r.label);

  test("★ 删掉中间那个位子：剩下的 label 逐字不动（1/2/3 删掉 2 → 剩 1 和 3，**不是** 1 和 2）", async () => {
    const tpl = await v2Template(6101);
    const res = await patchRoles(tpl.id, [
      { label: "1", desc: "第 1 个人" },
      { label: "3", desc: "第 3 个人" },
    ]);
    expect(res.status).toBe(200);
    // ★★ 数组相等，不是集合相等：重排（把 3 顺手改成 2）在集合相等下看不出来，
    //   而它的后果是套用者挂给 3 号的卡换到了另一个人身上，两边都不报错。
    expect(res.body.template.roles.map((r) => r.label)).toEqual(["1", "3"]);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "3"]);
    expect(doc.roles.map((r) => r.label)).not.toContain("2"); // 没有把空出来的 2 补回来
    // desc 跟着**自己那一条**走，没有按下标滑到别人身上
    expect(doc.roles.map((r) => r.desc)).toEqual(["第 1 个人", "第 3 个人"]);
    // 删位即确认：作者删掉它，正是因为他对着画面看清了"这个号不存在"
    expect(doc.roles.every((r) => r.labelConfirmed === true)).toBe(true);
  });

  test("★ 重号场景的完整修复：改号 + 删位**一次**提交（实出 2/2/1/1/5 → 只剩 2、1、5 三个可寻址的号）", async () => {
    const tpl = await v2Template(6102, { roles: guessed(5) });
    const res = await patchRoles(tpl.id, [
      { label: "2", desc: "第 1 个人" },
      { label: "1", desc: "第 3 个人" },
      { label: "5", desc: "第 5 个人" },
    ]);
    expect(res.status).toBe(200);
    // ★ 顺序按**作者提交的**来，不许被排成 1,2,5：App 侧按 roles 原序落参考图，
    //   这个顺序决定预算不够时谁先被挤掉，也是挂卡列表的显示顺序。
    expect(await labelsIn(tpl.id)).toEqual(["2", "1", "5"]);
    expect(res.body.template.roles.map((r) => r.label)).toEqual(["2", "1", "5"]);
  });

  test("★ 分两步做不到：任何「先改后删」的中间态都会撞重号闸，而那一句必须指出「删掉一个位子」", async () => {
    // ★★ 这条是"为什么不新开 DELETE 端点"的证据：作者要把 1,2,3,4,5 改成 2,1,5，
    //   先把 1 号位改成画面上真实的 "2" —— 库里已经有 "2" → 必然 400。
    //   所以改号与删位只能是同一次原子提交，而整份替换本来就是为它设计的。
    const tpl = await v2Template(6103, { roles: guessed(5) });
    const denied = await patchRoles(tpl.id, [
      { label: "2", desc: "第 1 个人（画面上其实印着 2）" },
      ...guessed(5).slice(1),
    ]);
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/编号/);
    expect(denied.body.message).toMatch(/删掉/); // 只说"不许重复"等于把人堵在原地
    expect(await labelsIn(tpl.id)).toEqual(["1", "2", "3", "4", "5"]); // 库里一个字没动
  });

  test("删一个库里压根不存在的号：这一格**没有错误路径**（提交那份本来就不含它 → 200 无操作）", async () => {
    const tpl = await v2Template(6104);
    const res = await patchRoles(tpl.id, guessed(3)); // 作者想删"9 号位"，可库里从来没有 9
    expect(res.status).toBe(200);
    expect(await labelsIn(tpl.id)).toEqual(["1", "2", "3"]);
  });

  test("删同一个号两次是幂等的（不 404、不报错）—— DELETE 端点才需要回答的那道题，这里不存在", async () => {
    const tpl = await v2Template(6105);
    const kept = [
      { label: "1", desc: "第 1 个人" },
      { label: "3", desc: "第 3 个人" },
    ];
    await patchRoles(tpl.id, kept).expect(200);
    const again = await patchRoles(tpl.id, kept); // 作者手抖点了第二次
    expect(again.status).toBe(200);
    expect(await labelsIn(tpl.id)).toEqual(["1", "3"]);
  });

  test("非本人删不动（403，身份只认 ownerId，且说的是中文整句），库里一条都不少", async () => {
    const tpl = await v2Template(6106);
    const res = await patchRoles(tpl.id, [{ label: "1", desc: "第 1 个人" }], asOther);
    expect(res.status).toBe(403);
    // ★ App 把这句话原样显示给用户 —— 英文机器串印在界面上等于没解释
    expect(res.body.message).toMatch(/作者本人/);
    expect(await labelsIn(tpl.id)).toEqual(["1", "2", "3"]);
  });

  test("已发布的模板删不了位（400，「下架」和「删」两个字都要在），下架之后同一发就过", async () => {
    // ★★ 删位比改号更狠：改号是"卡挂到别人身上"，删位是"这张卡直接挂不上了" ——
    //   套用者手里的 cast[label] 会指向一个不存在的位子，而市场条目还挂着。
    const tpl = await v2Template(6107);
    await patchRoles(tpl.id, guessed(3)).expect(200);
    await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner()).expect(200);

    const shorter = [
      { label: "1", desc: "第 1 个人" },
      { label: "3", desc: "第 3 个人" },
    ];
    const denied = await patchRoles(tpl.id, shorter);
    expect(denied.status).toBe(400);
    expect(denied.body.message).toMatch(/下架/);
    expect(denied.body.message).toMatch(/删/); // 那句话必须把"删位"也明说进去
    expect(await labelsIn(tpl.id)).toEqual(["1", "2", "3"]);

    await request(app).patch(`/api/branch/templates/${tpl.id}/unpublish`).set(asOwner()).expect(200);
    await patchRoles(tpl.id, shorter).expect(200);
    expect(await labelsIn(tpl.id)).toEqual(["1", "3"]);
  });

  test("★ 边界：能删到只剩最后一个（200，且留下的那个号不被重编），再删空 → 400 中文整句，库里纹丝不动", async () => {
    const tpl = await v2Template(6108);
    const last = await patchRoles(tpl.id, [{ label: "3", desc: "第 3 个人" }]);
    expect(last.status).toBe(200);
    expect(await labelsIn(tpl.id)).toEqual(["3"]); // ★ 剩最后一个也不许被重编成 "1"

    const empty = await patchRoles(tpl.id, []);
    expect(empty.status).toBe(400);
    // ★★ 删到 0 会触发一条四段全静默的降级链（响应退成 V1 形状 → App 静默退成泛指
    //   出片，套用者付了钱换来一段"AI 自己挑人换"的片 → 发布闸同时失效）。
    //   所以它必须被拒，而且要说得出下一步（"整个模板不要了就删模板"）。
    expect(empty.body.message).not.toMatch(/Validation error/); // 不是 zod 那句英文
    expect(empty.body.message).toMatch(/至少/);
    expect(empty.body.message).toMatch(/删除这个模板/);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["3"]);
    expect(doc.roles.every((r) => r.labelConfirmed === true)).toBe(true); // 没被这一发反悔
  });

  test("下限这条规则只有一处实现：zod 放行空数组（形状合法），由 handler 用人话拒；缺键仍归 zod", () => {
    const { patchRolesBody } = require("../src/schemas/branchTemplate.schemas");
    expect(patchRolesBody.safeParse({ roles: [] }).success).toBe(true);
    expect(patchRolesBody.safeParse({}).success).toBe(false);
  });

  test("删位**不清 provenAt**：作者不用为了删一个画面上不存在的号再付一次 r2v 的钱", async () => {
    // ★ 试炼证明的是"这个模板出得了片"，与角色位个数无关。顺手清掉就等于再收一次学费。
    const tpl = await v2Template(6109);
    await patchRoles(tpl.id, [{ label: "1", desc: "第 1 个人" }]).expect(200);
    expect((await BranchTemplate().findById(tpl.id).lean()).provenAt).toBeTruthy();
    await request(app).patch(`/api/branch/templates/${tpl.id}/publish`).set(asOwner()).expect(200);
  });

  test("删位碰不到钱与身份：同一发里塞 refVideo/status/ownerId，删成功但那三样一个都没动", async () => {
    const tpl = await v2Template(6110);
    const res = await request(app)
      .patch(`/api/branch/templates/${tpl.id}/roles`)
      .set(asOwner())
      .send({
        roles: [
          { label: "1", desc: "第 1 个人" },
          { label: "3", desc: "第 3 个人" },
        ],
        status: "published",
        ownerId: other.id,
        refVideo: { durationSec: 1, url: "https://evil.example.com/x.mp4" },
      });
    expect(res.status).toBe(200);
    const doc = await BranchTemplate().findById(tpl.id).lean();
    expect(doc.roles.map((r) => r.label)).toEqual(["1", "3"]);
    expect(doc.status).toBe("pending");
    expect(String(doc.ownerId)).toBe(String(owner.id));
    expect(doc.refVideo.durationSec).toBe(10); // Cloudinary 的登记值，不是客户端报的 1
  });
});
