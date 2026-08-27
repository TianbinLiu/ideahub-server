// tests/promptSchemeMarket.spec.js
// 覆盖：「提示词方案」的库 + 广场（存 / 发布 / 逛 / 装）。
//
// ★ 这套用例盯的是几类【做错了不报错】的问题，与卡片那套同源：
//   S1 图位字段被 z.object 或序列化**逐字段重建**时静默 strip —— ref/size/fromCrop
//      漏一个不会让任何请求失败，只会让**装回来的方案行为变了**（参考图从脸变成主裁剪、
//      原本不花钱的那一格开始花钱），而没有任何一处会说话。
//   S2 路由顺序 —— /schemes/shared 排在 /schemes/:schemeId 后面时，"shared" 会被当成
//      一个 schemeId，返回看起来只是"广场还没人发方案"。
//   S3 装方案必须**幂等且不覆盖**：装过之后用户可能改过自己那份，再装一次把他改的
//      内容抹掉是静默的数据损失。
//   S4 改内容不许把已下架的方案偷偷再发布出去（published 不该被 upsert 顺手带上）。
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

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `ps${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

let schemeSeq = 0;
function schemeOf(extra = {}) {
  schemeSeq += 1;
  return {
    schemeId: extra.schemeId || `ps_test_${schemeSeq}_${Date.now().toString(36)}`,
    title: "无面部白模三视图",
    intro: "人脸与服装分离",
    faceless: true,
    slots: [
      // ★ 这一格**故意把三个可选位都写上**：S1 盯的就是它们会不会被吃掉
      { tag: "白模全身", role: "primary", prompt: "头部替换为纯白色人台模型", ref: "face", size: "1728x2304" },
      { tag: "原片截图", role: "display", prompt: "", fromCrop: true },
    ],
    ...extra,
  };
}

function putScheme(token, body) {
  return request(app).post("/api/branch/schemes").set("Authorization", `Bearer ${token}`).send(body);
}

describe("提示词方案 · 库与广场", () => {
  test("S1 方案能存能读，图位的 ref/size/fromCrop 一个都不能丢", async () => {
    const me = await registerUser();
    const s = schemeOf();
    const created = await putScheme(me.token, s).expect(201);
    expect(created.body.scheme.slots).toHaveLength(2);

    // 回读：201 的回包可能只是内存里的对象，真正的判据是从库里查出来还在
    const listed = await request(app)
      .get("/api/branch/schemes")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const got = listed.body.schemes.find((x) => x.schemeId === s.schemeId);
    expect(got.slots[0]).toEqual({
      tag: "白模全身",
      role: "primary",
      prompt: "头部替换为纯白色人台模型",
      ref: "face",
      size: "1728x2304",
    });
    // 缺省的那几位**不该被补出默认值**（缺省的语义在客户端有唯一实现）
    expect(got.slots[1]).toEqual({ tag: "原片截图", role: "display", prompt: "", fromCrop: true });
    expect(got.faceless).toBe(true);
  });

  test("S2 /schemes/shared 不会被 /schemes/:schemeId 吃掉；发布 → 出现，下架 → 消失", async () => {
    const author = await registerUser();
    const s = schemeOf({ title: "分栏设定稿" });
    await putScheme(author.token, s).expect(201);

    // 没发布时广场上没有
    let shared = await request(app).get("/api/branch/schemes/shared").expect(200);
    expect(shared.body.schemes.find((x) => x.schemeId === s.schemeId)).toBeUndefined();

    await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    shared = await request(app).get("/api/branch/schemes/shared").expect(200);
    expect(shared.body.schemes.find((x) => x.schemeId === s.schemeId)).toBeTruthy();

    await request(app)
      .delete(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    shared = await request(app).get("/api/branch/schemes/shared").expect(200);
    expect(shared.body.schemes.find((x) => x.schemeId === s.schemeId)).toBeUndefined();
  });

  test("S3 装方案：装得到、幂等，且第二次不覆盖我已经改过的那份", async () => {
    const author = await registerUser();
    const taker = await registerUser();
    const s = schemeOf({ title: "原版标题" });
    await putScheme(author.token, s).expect(201);
    await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const first = await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    // 作者名跟着**原作者**走，不是装的人 —— 市场上要看得出这套是谁做的
    expect(first.body.scheme.title).toBe("原版标题");
    expect(first.body.scheme.published).toBe(false);

    // 装走之后自己改了标题
    await putScheme(taker.token, { ...s, title: "我改过的标题" }).expect(201);
    // 再装一次：必须是幂等的，且**不能**把我改的抹掉
    const again = await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(200);
    expect(again.body.alreadyInstalled).toBe(true);
    expect(again.body.scheme.title).toBe("我改过的标题");

    const mine = await request(app)
      .get("/api/branch/schemes")
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(200);
    expect(mine.body.schemes.filter((x) => x.schemeId === s.schemeId)).toHaveLength(1);
  });

  test("S4 改内容不会把已下架的方案偷偷重新发布出去", async () => {
    const author = await registerUser();
    const s = schemeOf();
    await putScheme(author.token, s).expect(201);
    await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    await request(app)
      .delete(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    await putScheme(author.token, { ...s, title: "改个名字" }).expect(201);
    const shared = await request(app).get("/api/branch/schemes/shared").expect(200);
    expect(shared.body.schemes.find((x) => x.schemeId === s.schemeId)).toBeUndefined();
  });

  test("S5 非法输入一律 400，而且一行都不落库", async () => {
    const me = await registerUser();
    const before = await request(app).get("/api/branch/schemes").set("Authorization", `Bearer ${me.token}`);
    const n0 = before.body.schemes.length;

    // 图位一个都没有
    await putScheme(me.token, schemeOf({ slots: [] })).expect(400);
    // 图位超过 3（与卡片 views 同一个上限：多的存不进 views）
    await putScheme(
      me.token,
      schemeOf({ slots: Array(4).fill({ tag: "a", role: "primary", prompt: "x" }) })
    ).expect(400);
    // role 不在受控词表里
    await putScheme(me.token, schemeOf({ slots: [{ tag: "a", role: "hero", prompt: "x" }] })).expect(400);
    // tag 超长（客户端 maxLength 只是第一道，服务端这道是真的会 400）
    await putScheme(me.token, schemeOf({ slots: [{ tag: "字".repeat(25), role: "primary", prompt: "x" }] })).expect(400);

    const after = await request(app).get("/api/branch/schemes").set("Authorization", `Bearer ${me.token}`);
    expect(after.body.schemes.length).toBe(n0);
  });

  test("S6 别人的方案我删不掉、也发布不了（越权一律 404，不泄露存在性）", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const s = schemeOf();
    await putScheme(author.token, s).expect(201);

    await request(app)
      .delete(`/api/branch/schemes/${s.schemeId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);
    await request(app)
      .post(`/api/branch/schemes/${s.schemeId}/publish`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);

    // 作者自己那份还在，且仍未发布
    const mine = await request(app)
      .get("/api/branch/schemes")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(mine.body.schemes.find((x) => x.schemeId === s.schemeId).published).toBe(false);
  });
});
