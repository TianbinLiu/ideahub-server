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

  // ★ views（卡片多图参考）是 2026-08-11 新加的字段，和 deck 当年一样有"发得出、存不下"
  //   的风险：deckCardBody 是 .loose()（收下未声明字段），所以坏在**模型 + 控制器白名单**
  //   那一层 —— 落库时被静默丢掉。后果不会让任何请求失败，只是观众装走这套卡组后，
  //   AI 少了形象参考，炼出来的人物"有点不像"，没人查得到这里。
  test("V3b deck 里的 views 跟着作品一起落库（非 http 的那张不带出去）", async () => {
    const author = await registerUser();
    const deck = {
      name: "带参考图的卡组",
      cards: [
        {
          id: "card_hero",
          type: "character",
          name: "主角",
          cover: "https://cdn.example.com/hero.jpg",
          views: [
            { url: "https://cdn.example.com/hero-face.jpg", kind: "face", note: "大头照" },
            { url: "idb:local-only", kind: "body" }, // 设备本地指针：别人拿到是死链
          ],
        },
      ],
    };
    const created = await publish(author.token, { title: "带参考图的作品", deck }).expect(201);
    const id = String(created.body.video._id);
    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    const card = detail.body.video.deck.cards[0];
    expect(card.views).toHaveLength(1);
    expect(card.views[0].url).toBe("https://cdn.example.com/hero-face.jpg");
    expect(card.views[0].kind).toBe("face");
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

describe("段字段不会被悄悄 strip 掉", () => {
  // ★ 这条盯的是「加了字段但服务端存不下」这个**反复出现**的坑。
  //   丢字段有两个地方，加字段时两处都要动，只动一处症状完全一样（201 成功、读回来没有）：
  //     1. schemas/branchVideo.schemas.js 的 z.object —— 默认 strip 未声明字段
  //     2. controllers/branchVideo.controller.js 的 transferSegment —— 逐字段重建
  //   deck 丢过一次，aspect/videoTier 丢过一次（同事的画幅功能，2026-08-11 发现）。
  test("画幅与档位随作品落库，读得回来", async () => {
    const author = await registerUser();
    const created = await request(app)
      .post("/api/branch/videos")
      .set("Authorization", `Bearer ${author.token}`)
      .send({
        title: "横屏作品",
        segments: [
          {
            title: "第一段",
            firstFrame: "https://cdn.example.com/a.jpg",
            durationSec: 5,
            aspect: "landscape",
            videoTier: "doubao-seedance-1-0-pro-250528",
          },
        ],
      })
      .expect(201);

    expect(created.body.video.segments[0].aspect).toBe("landscape");
    expect(created.body.video.segments[0].videoTier).toBe("doubao-seedance-1-0-pro-250528");

    const detail = await request(app).get(`/api/branch/videos/${created.body.video._id}`).expect(200);
    expect(detail.body.video.segments[0].aspect).toBe("landscape");
    expect(detail.body.video.segments[0].videoTier).toBe("doubao-seedance-1-0-pro-250528");
  });

  test("不带画幅的老客户端不会被塞一个默认值", async () => {
    // ★ "没有这个字段"和"明确是横屏"必须分得开：app 的 aspectOf() 把缺省当横屏，
    //   给了 default 等于替老数据做了一个它没做过的声明
    const author = await registerUser();
    const created = await publish(author.token, { title: "老客户端发的" }).expect(201);
    expect(created.body.video.segments[0].aspect).toBeUndefined();
    expect(created.body.video.segments[0].videoTier).toBeUndefined();
  });

  test("非法画幅值挡在门口（400），不落库", async () => {
    const author = await registerUser();
    await request(app)
      .post("/api/branch/videos")
      .set("Authorization", `Bearer ${author.token}`)
      .send({ title: "歪的", segments: [{ firstFrame: "https://cdn.example.com/a.jpg", aspect: "square" }] })
      .expect(400);
  });
});

describe("付费设置与封面编辑", () => {
  test("pricing 随作品落库（之前被 z.object strip 掉，作者收益恒为 0）", async () => {
    const author = await registerUser();
    const created = await publish(author.token, {
      title: "付费作品",
      pricing: { mode: "paid", partPrices: [5000] },
    }).expect(201);
    expect(created.body.video.pricing).toEqual({ mode: "paid", partPrices: [5000] });

    const detail = await request(app).get(`/api/branch/videos/${created.body.video._id}`).expect(200);
    expect(detail.body.video.pricing.partPrices).toEqual([5000]);
  });

  test("免费作品不落 pricing，也不在响应里冒出来", async () => {
    const author = await registerUser();
    const a = await publish(author.token, { title: "免费1" }).expect(201);
    const b = await publish(author.token, { title: "免费2", pricing: { mode: "free", partPrices: [0] } }).expect(201);
    expect(a.body.video.pricing).toBeUndefined();
    expect(b.body.video.pricing).toBeUndefined();
  });

  test("PATCH 可以换封面，但只收 http(s) URL（dataURL 一律 400）", async () => {
    const author = await registerUser();
    const id = String((await publish(author.token, { title: "换封面" })).body.video._id);
    const auth = { Authorization: `Bearer ${author.token}` };

    const ok = await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set(auth)
      .send({ cover: "https://res.cloudinary.com/x/new-cover.jpg" })
      .expect(200);
    expect(ok.body.video.cover).toBe("https://res.cloudinary.com/x/new-cover.jpg");

    // ★ dataURL 必须挡在门口：几百 KB 的 base64 会撞上网关 1MB 上限，
    //   而且撞了只表现成 fetch failed，看不出是因为太大。客户端要先传成 URL。
    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set(auth)
      .send({ cover: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" })
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 按作者列作品（GET /api/branch/videos?author=<userId>）
//
// ★ 这组盯的是**新能力最容易做错的那一处**：author 是个筛选条件，不是可见性的替代品。
//   忘了跟 visibilityFilter 求交集，一行代码就能把全站的私密作品倒出来 —— 而且
//   接口 200、字段齐全，看起来完全正常，只有作者本人某天刷到自己没发出去的东西才会发现。
// ─────────────────────────────────────────────────────────────────────
describe("按作者列作品", () => {
  const listByAuthor = (authorId, token) => {
    const req = request(app).get(`/api/branch/videos?author=${authorId}`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  test("A1 陌生人的主页：只给公开作品，私密的一条都不给", async () => {
    const author = await registerUser();
    const stranger = await registerUser();

    const open = String((await publish(author.token, { title: "作者的公开作品" }).expect(201)).body.video._id);
    const secret = String(
      (await publish(author.token, { title: "作者的私密作品", visibility: "private" }).expect(201)).body.video._id
    );
    // 别人的作品：不该出现在这一页里（证明 author 真的在筛，不是把全站原样返回）
    const other = String((await publish(stranger.token, { title: "别人的作品" }).expect(201)).body.video._id);

    // 未登录看
    const anon = await listByAuthor(author.userId).expect(200);
    expect(idsOf(anon.body)).toContain(open);
    expect(idsOf(anon.body)).not.toContain(secret);
    expect(idsOf(anon.body)).not.toContain(other);

    // 登录成另一个人看 —— 同样看不到私密的
    const byStranger = await listByAuthor(author.userId, stranger.token).expect(200);
    expect(idsOf(byStranger.body)).toContain(open);
    expect(idsOf(byStranger.body)).not.toContain(secret);
  });

  test("A2 问自己要：私密作品必须在里面（否则作者看不见自己的草稿箱）", async () => {
    const author = await registerUser();
    const open = String((await publish(author.token, { title: "自己的公开" }).expect(201)).body.video._id);
    const secret = String(
      (await publish(author.token, { title: "自己的私密", visibility: "private" }).expect(201)).body.video._id
    );

    const mine = await listByAuthor(author.userId, author.token).expect(200);
    expect(idsOf(mine.body)).toEqual(expect.arrayContaining([open, secret]));
  });

  test("A3 author 与其它筛选条件求交集，不是互相覆盖", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const tag = `搜${Date.now().toString(36)}`;

    const hit = String((await publish(author.token, { title: `${tag} 命中` }).expect(201)).body.video._id);
    const wrongAuthor = String((await publish(other.token, { title: `${tag} 别人的` }).expect(201)).body.video._id);
    const wrongTitle = String((await publish(author.token, { title: "同一个人但标题不含关键词" }).expect(201)).body.video._id);

    const res = await request(app)
      .get(`/api/branch/videos?author=${author.userId}&q=${encodeURIComponent(tag)}`)
      .expect(200);
    expect(idsOf(res.body)).toEqual([hit]);
    expect(idsOf(res.body)).not.toContain(wrongAuthor);
    expect(idsOf(res.body)).not.toContain(wrongTitle);
  });

  test("A4 id 拼错是 400，不是 500，也不是一个骗人的空列表", async () => {
    // ★ 放任非法 id 进 Mongo 会抛 CastError → 被兜成 500，
    //   让人去查一个根本不存在的服务器故障；而静默返回空列表则等于告诉调用方
    //   "这个人没有作品"，两件事在界面上必须分得开。
    await request(app).get("/api/branch/videos?author=not-an-object-id").expect(400);

    // 合法但不存在的 id：空列表才是对的（这个人确实没有作品）
    const ghost = new mongoose.Types.ObjectId().toString();
    const res = await request(app).get(`/api/branch/videos?author=${ghost}`).expect(200);
    expect(res.body.items).toEqual([]);
  });
});
