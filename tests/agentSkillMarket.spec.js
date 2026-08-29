// tests/agentSkillMarket.spec.js
// 覆盖：「出片技能」的库 + 广场（存 / 发布 / 逛 / 装）。
// ★ 盯的与方案市场同一批【做错了不报错】的问题：
//   K1 路由顺序 —— /skills/shared 排错时 "shared" 被当成 skillId，看起来只是"广场没人发"；
//   K2 装技能必须幂等且不覆盖（装过之后用户可能改过自己那份）；
//   K3 改内容不许把已下架的偷偷再发布（published 不该被 upsert 顺手带上）；
//   K4 text 是技能本体 —— toSkillPayload 漏了它就是"装回来是空壳"，零报错。
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
  const name = `ask${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

let skillSeq = 0;
function skillOf(extra = {}) {
  skillSeq += 1;
  return {
    skillId: extra.skillId || `ask_test_${skillSeq}_${Date.now().toString(36)}`,
    title: "雨夜三连",
    intro: "一句话铺三段雨夜戏",
    text: "加两段；第1段拍雨夜霓虹街的追逐；第2段拍拉面店前的对峙",
    ...extra,
  };
}

describe("出片技能：库 + 广场", () => {
  test("存 → 我的列表能读回全部字段（K4：text 是本体）", async () => {
    const u = await registerUser();
    const body = skillOf();
    const up = await request(app).post("/api/branch/skills").set("Authorization", `Bearer ${u.token}`).send(body).expect(201);
    expect(up.body.skill.text).toBe(body.text);
    expect(up.body.skill.published).toBe(false);

    const mine = await request(app).get("/api/branch/skills").set("Authorization", `Bearer ${u.token}`).expect(200);
    const got = mine.body.skills.find((s) => s.skillId === body.skillId);
    expect(got).toBeTruthy();
    expect(got.title).toBe(body.title);
    expect(got.intro).toBe(body.intro);
    expect(got.text).toBe(body.text);
  });

  test("广场路由顺序（K1）：没发布时 shared 是空数组，不是 404", async () => {
    const r = await request(app).get("/api/branch/skills/shared").expect(200);
    expect(Array.isArray(r.body.skills)).toBe(true);
  });

  test("发布 → 别人逛得到、装得走；装是幂等且不覆盖（K2）", async () => {
    const author = await registerUser();
    const buyer = await registerUser();
    const body = skillOf();
    await request(app).post("/api/branch/skills").set("Authorization", `Bearer ${author.token}`).send(body).expect(201);
    await request(app)
      .post(`/api/branch/skills/${body.skillId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const shared = await request(app).get("/api/branch/skills/shared").expect(200);
    const row = shared.body.skills.find((s) => s.skillId === body.skillId);
    expect(row).toBeTruthy();
    expect(row.text).toBe(body.text);

    const inst = await request(app)
      .post(`/api/branch/skills/${body.skillId}/install`)
      .set("Authorization", `Bearer ${buyer.token}`)
      .expect(201);
    expect(inst.body.skill.text).toBe(body.text);
    expect(inst.body.skill.published).toBe(false); // 装了不等于替对方转发

    // 买家改自己那份 → 再装一次必须回改过的那份（不覆盖）
    const edited = { ...body, text: "第1段拍我自己改过的版本" };
    await request(app).post("/api/branch/skills").set("Authorization", `Bearer ${buyer.token}`).send(edited).expect(201);
    const again = await request(app)
      .post(`/api/branch/skills/${body.skillId}/install`)
      .set("Authorization", `Bearer ${buyer.token}`)
      .expect(200);
    expect(again.body.alreadyInstalled).toBe(true);
    expect(again.body.skill.text).toBe(edited.text);
  });

  test("改内容不带 published（K3）：下架后 upsert 内容，广场仍看不见", async () => {
    const u = await registerUser();
    const body = skillOf();
    const auth = (r) => r.set("Authorization", `Bearer ${u.token}`);
    await auth(request(app).post("/api/branch/skills")).send(body).expect(201);
    await auth(request(app).post(`/api/branch/skills/${body.skillId}/publish`)).expect(200);
    await auth(request(app).delete(`/api/branch/skills/${body.skillId}/publish`)).expect(200);
    await auth(request(app).post("/api/branch/skills")).send({ ...body, text: "改过的内容" }).expect(201);

    const shared = await request(app).get("/api/branch/skills/shared").expect(200);
    expect(shared.body.skills.find((s) => s.skillId === body.skillId)).toBeFalsy();
  });

  test("删除自己的；删不存在的 404", async () => {
    const u = await registerUser();
    const body = skillOf();
    const auth = (r) => r.set("Authorization", `Bearer ${u.token}`);
    await auth(request(app).post("/api/branch/skills")).send(body).expect(201);
    await auth(request(app).delete(`/api/branch/skills/${body.skillId}`)).expect(200);
    await auth(request(app).delete(`/api/branch/skills/${body.skillId}`)).expect(404);
  });

  test("越权：不登录存不了；正文超 400 整发 400", async () => {
    await request(app).post("/api/branch/skills").send(skillOf()).expect(401);
    const u = await registerUser();
    await request(app)
      .post("/api/branch/skills")
      .set("Authorization", `Bearer ${u.token}`)
      .send(skillOf({ text: "长".repeat(401) }))
      .expect(400);
  });
});
