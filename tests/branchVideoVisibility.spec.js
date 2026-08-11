// tests/branchVideoVisibility.spec.js
// 覆盖：作品可见性（public/private）、随作品发布的卡组快照、作品编辑端点。
//
// ★ 这套用例盯的是三类【做错了不报错、只是悄悄丢东西或悄悄泄漏】的问题：
//   V1 私密作品不能被别人看到 —— 列表、详情、以及点赞/评论/播放这些子端点
//      **每一条都要挡**。只挡详情不挡子端点，等于留了个探测旁路。
//   V2 存量作品（没有 visibility 字段）必须继续可见 —— 按 `=== "public"` 判
//      会把库里所有老作品从首页上抹掉，而且这事儿一点错都不报。
//   V3 deck 要真的落库 —— 它之前就是被 zod 的 strip 默默吃掉的：
//      客户端发了、服务端 201 了、读回来是空的。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let BranchVideo;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchVideo = require("../src/models/BranchVideo");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `bv${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

/** 发一条作品。资源全用 https 外链，避免用例去真的碰 Cloudinary */
function publish(token, extra = {}) {
  return request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "测试作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 3 }],
      ...extra,
    });
}

const idsOf = (body) => (body.items || []).map((v) => String(v._id));

describe("作品可见性", () => {
  test("V1 默认公开：不登录也能在列表和详情里看到", async () => {
    const author = await registerUser();
    const created = await publish(author.token, { title: "公开的" }).expect(201);
    const id = String(created.body.video._id);
    expect(created.body.video.visibility).toBe("public");

    const list = await request(app).get("/api/branch/videos").expect(200);
    expect(idsOf(list.body)).toContain(id);

    await request(app).get(`/api/branch/videos/${id}`).expect(200);
  });

  test("V1 私密作品：别人列表里没有、详情 404、作者自己两处都看得到", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const created = await publish(author.token, { title: "私密的", visibility: "private" }).expect(201);
    const id = String(created.body.video._id);
    expect(created.body.video.visibility).toBe("private");

    // 匿名
    expect(idsOf((await request(app).get("/api/branch/videos").expect(200)).body)).not.toContain(id);
    await request(app).get(`/api/branch/videos/${id}`).expect(404);

    // 别的登录用户
    const otherList = await request(app)
      .get("/api/branch/videos")
      .set("Authorization", `Bearer ${other.token}`)
      .expect(200);
    expect(idsOf(otherList.body)).not.toContain(id);
    await request(app)
      .get(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);

    // 作者本人 —— 个人页要靠这条才能列出自己的私密作品
    const mine = await request(app)
      .get("/api/branch/videos")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(idsOf(mine.body)).toContain(id);
    await request(app)
      .get(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
  });

  test("V1 子端点也要挡：播放/点赞/评论对私密作品一律 404", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const id = String((await publish(author.token, { visibility: "private" }).expect(201)).body.video._id);

    await request(app).post(`/api/branch/videos/${id}/play`).expect(404);
    await request(app)
      .post(`/api/branch/videos/${id}/like`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);
    await request(app)
      .get(`/api/branch/videos/${id}/comments`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);
    await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ text: "偷看" })
      .expect(404);
  });

  test("V1 搜索也不能漏：q 命中私密作品同样不返回", async () => {
    const author = await registerUser();
    const kw = `kw${Date.now().toString(36)}`;
    const pub = String((await publish(author.token, { title: `${kw}公开` })).body.video._id);
    const priv = String(
      (await publish(author.token, { title: `${kw}私密`, visibility: "private" })).body.video._id
    );

    // 搜索占用了顶层 $or，可见性条件必须用 $and 拼进去，否则这里会漏
    const res = await request(app).get("/api/branch/videos").query({ q: kw }).expect(200);
    expect(idsOf(res.body)).toContain(pub);
    expect(idsOf(res.body)).not.toContain(priv);
  });

  test("V2 存量作品（库里没有 visibility 字段）仍然可见", async () => {
    const author = await registerUser();
    const id = String((await publish(author.token, { title: "老作品" })).body.video._id);
    // 模拟加字段之前入库的文档
    await BranchVideo.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $unset: { visibility: "" } }
    );

    expect(idsOf((await request(app).get("/api/branch/videos").expect(200)).body)).toContain(id);
    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(detail.body.video.visibility).toBe("public"); // 对外归一，客户端不用判 undefined
  });
});

describe("卡组快照", () => {
  test("V3 deck 随作品落库，详情与列表都读得回来", async () => {
    const author = await registerUser();
    const deck = {
      name: "鹿？",
      cards: [
        {
          id: "card_deer",
          type: "character",
          name: "小鹿",
          summary: "一只鹿",
          cover: "https://cdn.example.com/deer.jpg",
          tags: ["森林"],
          genPrompt: "本地字段，不该入库", // .loose() 收下但模型里没有
        },
      ],
    };
    const created = await publish(author.token, { title: "带卡组的", deck }).expect(201);
    const id = String(created.body.video._id);
    expect(created.body.video.deck.cards).toHaveLength(1);
    // 客户端的 id 落库统一叫 cardId
    expect(created.body.video.deck.cards[0].cardId).toBe("card_deer");
    expect(created.body.video.deck.name).toBe("鹿？");

    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(detail.body.video.deck.cards[0].name).toBe("小鹿");
    expect(detail.body.video.deck.cards[0].cover).toBe("https://cdn.example.com/deer.jpg");
    expect(detail.body.video.deck.cards[0].genPrompt).toBeUndefined();
  });

  test("没有卡组的作品不会凭空多出一个空 deck", async () => {
    const author = await registerUser();
    const created = await publish(author.token, { title: "没卡组" }).expect(201);
    expect(created.body.video.deck).toBeUndefined();
  });
});

describe("作品编辑（PATCH）", () => {
  test("作者可以改标题与可见性，改完立刻在别人那边生效", async () => {
    const author = await registerUser();
    const id = String((await publish(author.token, { title: "改名前" })).body.video._id);

    const patched = await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ title: "改名后", visibility: "private" })
      .expect(200);
    expect(patched.body.video.title).toBe("改名后");
    expect(patched.body.video.visibility).toBe("private");

    await request(app).get(`/api/branch/videos/${id}`).expect(404);

    // 再改回公开
    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ visibility: "public" })
      .expect(200);
    const back = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(back.body.video.title).toBe("改名后"); // 只改可见性没把标题冲掉
  });

  test("只传一个字段时不会把其它字段清空", async () => {
    const author = await registerUser();
    const id = String(
      (await publish(author.token, { title: "有简介的", description: "一段简介" })).body.video._id
    );

    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ visibility: "private" })
      .expect(200);

    const detail = await request(app)
      .get(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(detail.body.video.description).toBe("一段简介");
    expect(detail.body.video.title).toBe("有简介的");
  });

  test("不是作者就改不动（403），未登录 401", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const id = String((await publish(author.token)).body.video._id);

    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ title: "我改了" })
      .expect(403);

    await request(app).patch(`/api/branch/videos/${id}`).send({ title: "我改了" }).expect(401);
  });

  test("片段与卡组改不动：发布即定稿，这些字段一律被 strip", async () => {
    const author = await registerUser();
    const id = String(
      (await publish(author.token, { deck: { name: "原卡组", cards: [{ id: "c1", name: "原卡" }] } })).body
        .video._id
    );

    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({
        title: "只有标题会生效",
        segments: [{ title: "偷换的段", firstFrame: "https://evil.example.com/x.jpg" }],
        deck: { name: "偷换的卡组", cards: [] },
      })
      .expect(200);

    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(detail.body.video.title).toBe("只有标题会生效");
    expect(detail.body.video.segments[0].title).toBe("第一段");
    expect(detail.body.video.deck.name).toBe("原卡组");
  });

  test("空 patch 与非法可见性都要 400", async () => {
    const author = await registerUser();
    const id = String((await publish(author.token)).body.video._id);
    const auth = { Authorization: `Bearer ${author.token}` };

    await request(app).patch(`/api/branch/videos/${id}`).set(auth).send({}).expect(400);
    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set(auth)
      .send({ visibility: "friends" })
      .expect(400);
  });
});
