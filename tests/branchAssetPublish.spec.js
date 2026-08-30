// tests/branchAssetPublish.spec.js
// 覆盖：卡片/卡组「发布到创意工坊」+ 真实热度（GET /cards/shared、POST /assets/:kind/:key/*）。
//
// ★ 这套用例盯的是六类【做错了不报错】的问题：
//   A1 字段被 z.object 静默 strip —— modelUrl / genPrompt / coverCardId / description
//      四个都曾经是「客户端发了、服务端 201 了、读回来是空的」。只有回读才发现得了。
//   A2 路由顺序 —— /cards/shared 排在 /cards/:cardId 后面时，"shared" 会被当成 cardId，
//      返回的是 200 + 空广场，看起来只是"还没人分享"。
//   A3 卡片热度必须按 **cardId 全局**聚合，不是按 BranchCard 文档 —— 同一张市场卡在库里
//      是每个装过的人各一份，挂在文档上的话每个人看到的都是自己那份的 0，像丢了数据。
//   A4 点赞/收藏必须幂等且计数不漂移 —— 计数是从去重表 countDocuments 重算的，
//      连点两次 likes 必须还是 1。$inc 写法在这条上会涨到 2 而且校不回去。
//   A5 第三方版权模型不能被分享出去，设备本地指针（idb:）不能跟着卡走给别人 ——
//      前者是法律问题，后者是"答应了全息预览、别人打开什么都没有"。
//   A6 非法 kind/key 一律 400 —— 这两个值会进 Mongo 查询和计数表主键。
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
  const name = `ap${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

let cardSeq = 0;
function cardOf(extra = {}) {
  cardSeq += 1;
  return {
    cardId: extra.cardId || `mkt_test_${cardSeq}_${Date.now().toString(36)}`,
    type: "character",
    name: "测试角色",
    summary: "用于回归测试的卡",
    cover: "https://cdn.example.com/c.jpg",
    tags: ["测试"],
    ...extra,
  };
}

function addCards(token, cards) {
  return request(app).post("/api/branch/cards").set("Authorization", `Bearer ${token}`).send({ cards });
}

function auth(req, token) {
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
}

describe("卡片/卡组发布到创意工坊", () => {
  test("A1 modelUrl / genPrompt 必须能存下来（曾被 z.object 静默 strip）", async () => {
    const me = await registerUser();
    const card = cardOf({ modelUrl: "https://cdn.example.com/hero.glb", genPrompt: "厚涂插画风的剑客立绘" });
    const created = await addCards(me.token, [card]).expect(201);
    expect(created.body.cards[0].modelUrl).toBe("https://cdn.example.com/hero.glb");
    expect(created.body.cards[0].genPrompt).toBe("厚涂插画风的剑客立绘");

    // 回读一次：201 的回包可能是内存里的对象，真正的判据是从库里查出来还在
    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const back = listed.body.cards.find((c) => c.cardId === card.cardId);
    expect(back.modelUrl).toBe("https://cdn.example.com/hero.glb");
    expect(back.genPrompt).toBe("厚涂插画风的剑客立绘");
  });

  test("A1b 卡组的 coverCardId 与 description（客户端的 intro）必须能存下来", async () => {
    const me = await registerUser();
    const c1 = cardOf();
    const c2 = cardOf();
    await addCards(me.token, [c1, c2]).expect(201);

    const deck = (
      await request(app)
        .post("/api/branch/decks")
        .set("Authorization", `Bearer ${me.token}`)
        .send({ name: "我的卡组", cardIds: [c1.cardId, c2.cardId] })
        .expect(201)
    ).body.deck;

    await request(app)
      .patch(`/api/branch/decks/${deck._id}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ coverCardId: c2.cardId, description: "这套卡适合生成赛博朋克短片" })
      .expect(200);

    const listed = await request(app)
      .get("/api/branch/decks")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const back = listed.body.decks.find((d) => d._id === deck._id);
    expect(back.coverCardId).toBe(c2.cardId);
    expect(back.description).toBe("这套卡适合生成赛博朋克短片");

    // ★ 分享时不带 description 不能把已经写好的简介清空
    await request(app)
      .post(`/api/branch/decks/${deck._id}/publish`)
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const shared = await request(app).get("/api/branch/decks/shared").expect(200);
    const row = shared.body.decks.find((d) => d._id === deck._id);
    expect(row.description).toBe("这套卡适合生成赛博朋克短片");
  });

  test("A2 /cards/shared 不会被 /cards/:cardId 吃掉；发布 → 出现，取消 → 消失", async () => {
    const author = await registerUser();
    const card = cardOf({ name: "广场测试卡" });
    await addCards(author.token, [card]).expect(201);

    // 未发布时不在广场（游客也能读这条端点）
    let shared = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(shared.body.cards.some((c) => c.cardId === card.cardId)).toBe(false);

    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ description: "随便拿去用" })
      .expect(200);

    shared = await request(app).get("/api/branch/cards/shared").expect(200);
    const row = shared.body.cards.find((c) => c.cardId === card.cardId);
    expect(row).toBeTruthy();
    expect(row.description).toBe("随便拿去用");
    expect(row.author.username).toBeTruthy();

    // 搜得到，且正则元字符不会把 mongod 打挂（转义收口在 utils/regex.js）
    const hit = await request(app)
      .get(`/api/branch/cards/shared?q=${encodeURIComponent("广场测试卡")}`)
      .expect(200);
    expect(hit.body.cards.some((c) => c.cardId === card.cardId)).toBe(true);
    const evil = await request(app)
      .get(`/api/branch/cards/shared?q=${encodeURIComponent("(a+)+$")}`)
      .expect(200);
    expect(evil.body.cards).toHaveLength(0);

    await request(app)
      .delete(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    shared = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(shared.body.cards.some((c) => c.cardId === card.cardId)).toBe(false);
  });

  // ── GET /cards/:cardId（2026-08-30 新增）─────────────────────────
  //
  // ★★ 这组用例盯的是「一条卡片链接打不开」那个洞：客户端详情页原来只有两条来路
  //   （自己库里那份 / 上一页经路由 state 递过来的对象），于是分享链接、会话恢复、
  //   通知深链落地都是一句"这张卡不在你的收藏里"，而那张卡在广场上好好挂着。
  //   同时钉死权限口径：**未分享的一律 404，不是 403**（403 等于承认这个 id 存在）。
  test("A2c 按 id 读一张已分享的卡：游客也能读；未分享 / 不存在一律 404", async () => {
    const author = await registerUser();
    const card = cardOf({ name: "深链测试卡" });
    await addCards(author.token, [card]).expect(201);

    // 还没分享：游客 404，**卡主自己也 404** —— 这条端点只回答"广场上那份"，
    // 卡主要看自己的卡走 GET /cards（他自己的库）
    await request(app).get(`/api/branch/cards/${card.cardId}`).expect(404);
    await request(app)
      .get(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(404);

    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ description: "一句话推荐" })
      .expect(200);

    // 分享之后：游客读得到，且字段与广场列表同一份形状
    const guest = await request(app).get(`/api/branch/cards/${card.cardId}`).expect(200);
    expect(guest.body.card.cardId).toBe(card.cardId);
    expect(guest.body.card.name).toBe("深链测试卡");
    expect(guest.body.card.description).toBe("一句话推荐");
    expect(guest.body.card.author.username).toBeTruthy();
    expect(guest.body.card.installed).toBe(false);
    expect(guest.body.card.isOwner).toBe(false);

    // 登录的卡主读：isOwner / installed 两位都要对（客户端靠它们决定按钮长什么样）
    const own = await request(app)
      .get(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(own.body.card.isOwner).toBe(true);
    expect(own.body.card.installed).toBe(true);

    // 取消分享之后又回到 404（广场上没有了，链接也就不该再打得开）
    await request(app)
      .delete(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    await request(app).get(`/api/branch/cards/${card.cardId}`).expect(404);

    // 压根不存在的 id 也是 404，不是 500
    await request(app).get("/api/branch/cards/nope_not_a_real_card").expect(404);
  });

  test("A2d /cards/shared 没被新端点吃掉（路由顺序）", async () => {
    // ★ "shared" 会不会被当成 cardId 送进 GET /cards/:cardId —— 那样广场会永远空着
    //   且返回 200，一点错都不报（这正是路由表里那条排序注释在防的事）。
    const res = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(Array.isArray(res.body.cards)).toBe(true);
  });

  test("A2b 只有卡主能发布自己的卡；别人发同名 cardId 只影响他自己那份", async () => {
    const author = await registerUser();
    const stranger = await registerUser();
    const card = cardOf();
    await addCards(author.token, [card]).expect(201);

    // 陌生人库里没有这张卡 → 404（不是 403：不该让人探出别人有哪些卡）
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(404);
    // 未登录 401
    await request(app).post(`/api/branch/cards/${card.cardId}/publish`).expect(401);
  });

  test("A3 卡片热度按 cardId 全局聚合：换个装过同一张卡的人读到的是同一个数", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const card = cardOf();
    await addCards(a.token, [card]).expect(201);
    await addCards(b.token, [card]).expect(201); // 同一个 cardId，库里两份文档

    await auth(request(app).post(`/api/branch/assets/card/${card.cardId}/like`), a.token).expect(200);

    const asA = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);
    const asB = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${b.token}`)
      .expect(200);
    const heatA = asA.body.cards.find((c) => c.cardId === card.cardId).stats.heat;
    const heatB = asB.body.cards.find((c) => c.cardId === card.cardId).stats.heat;
    expect(heatA).toBe(6); // 一个赞 = 6
    expect(heatB).toBe(heatA); // ★ 挂在文档上的话 B 会读到 0
  });

  test("A4 点赞/收藏幂等，计数不漂移；热度用的是仓库里唯一那条公式", async () => {
    const me = await registerUser();
    const card = cardOf();
    await addCards(me.token, [card]).expect(201);
    const base = `/api/branch/assets/card/${card.cardId}`;

    // 连点两次赞：计数必须还是 1（$inc 写法这里会变成 2）
    await auth(request(app).post(`${base}/like`), me.token).expect(200);
    const twice = await auth(request(app).post(`${base}/like`), me.token).expect(200);
    expect(twice.body.stats.likes).toBe(1);
    expect(twice.body.stats.liked).toBe(true);

    await auth(request(app).post(`${base}/bookmark`), me.token).expect(200);
    await request(app).post(`${base}/view`).expect(200); // 浏览允许匿名
    const stats = (await request(app).get(`${base}/stats`).expect(200)).body.stats;

    expect(stats).toMatchObject({ views: 1, likes: 1, bookmarks: 1 });
    // likes*6 + comments*4 + bookmarks*3 + min(views,5000)*0.04
    expect(stats.heat).toBeCloseTo(6 + 3 + 0.04, 5);
    // 未登录读同一条：数一样，但 liked/bookmarked 是 false
    expect(stats.liked).toBe(false);

    // 取消点赞回到 0，且 liked 立刻转 false
    const off = await auth(request(app).delete(`${base}/like`), me.token).expect(200);
    expect(off.body.stats.likes).toBe(0);
    expect(off.body.stats.liked).toBe(false);
  });

  test("A4b 点赞/收藏必须登录；未登录只能浏览和读数", async () => {
    const me = await registerUser();
    const card = cardOf();
    await addCards(me.token, [card]).expect(201);
    const base = `/api/branch/assets/card/${card.cardId}`;
    await request(app).post(`${base}/like`).expect(401);
    await request(app).post(`${base}/bookmark`).expect(401);
    await request(app).get(`${base}/stats`).expect(200);
  });

  test("A5 第三方版权模型不能分享；idb: 本地指针不跟着卡走", async () => {
    const author = await registerUser();
    const taker = await registerUser();

    // ① 第三方素材（/models/protected/ 下、非自有的 milltina）→ 400，不是"悄悄剥掉"
    const rin = cardOf({ modelUrl: "https://cdn.example.com/models/protected/rin-player-opt.glbx" });
    await addCards(author.token, [rin]).expect(201);
    await request(app)
      .post(`/api/branch/cards/${rin.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(400);

    // ② 设备本地指针：卡主自己那份留着，但别人装走的那份必须是空的
    const local = cardOf({ modelUrl: `idb:model3d:${Date.now()}` });
    await addCards(author.token, [local]).expect(201);
    await request(app)
      .post(`/api/branch/cards/${local.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const shared = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(shared.body.cards.find((c) => c.cardId === local.cardId).modelUrl).toBe("");

    const installed = await request(app)
      .post(`/api/branch/cards/${local.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    expect(installed.body.card.modelUrl).toBe("");
    // 卡主自己那份没被动
    const mine = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(mine.body.cards.find((c) => c.cardId === local.cardId).modelUrl).toMatch(/^idb:/);
  });

  test("A5b 装卡是幂等的：装两次只有一张，第二次说 alreadyInstalled", async () => {
    const author = await registerUser();
    const taker = await registerUser();
    const card = cardOf({ genPrompt: "会跟着卡一起走的蓝图" });
    await addCards(author.token, [card]).expect(201);
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const first = await request(app)
      .post(`/api/branch/cards/${card.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    expect(first.body.card.genPrompt).toBe("会跟着卡一起走的蓝图");

    const again = await request(app)
      .post(`/api/branch/cards/${card.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(200);
    expect(again.body.alreadyInstalled).toBe(true);

    const mine = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(200);
    expect(mine.body.cards.filter((c) => c.cardId === card.cardId)).toHaveLength(1);

    // 没发布的卡装不到
    const secret = cardOf();
    await addCards(author.token, [secret]).expect(201);
    await request(app)
      .post(`/api/branch/cards/${secret.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(404);
  });

  test("A6 非法 kind / key 一律 400（这两个值会进 Mongo 查询与计数表主键）", async () => {
    const me = await registerUser();
    await request(app).get("/api/branch/assets/video/abc/stats").expect(400);
    await request(app)
      .get(`/api/branch/assets/card/${encodeURIComponent("带空格 的key")}/stats`)
      .expect(400);
    await auth(
      request(app).post(`/api/branch/assets/card/${encodeURIComponent("$ne")}/like`),
      me.token
    ).expect(400);
  });

  test("A8 编出来的 key 一律 404，而且不能在库里留下任何一行", async () => {
    const me = await registerUser();
    const BranchAssetStat = require("../src/models/BranchAssetStat");
    const BranchAssetLike = require("../src/models/BranchAssetLike");
    const BranchAssetView = require("../src/models/BranchAssetView");

    // 字符集合法、但世上没有这张卡 —— parseAssetRef 只管前者
    const ghostCard = `mkt_nobody_has_this_${Date.now().toString(36)}`;
    const ghostDeck = new mongoose.Types.ObjectId().toString();

    await auth(request(app).post(`/api/branch/assets/card/${ghostCard}/like`), me.token).expect(404);
    await auth(request(app).post(`/api/branch/assets/card/${ghostCard}/bookmark`), me.token).expect(404);
    await auth(request(app).delete(`/api/branch/assets/card/${ghostCard}/like`), me.token).expect(404);
    await request(app).post(`/api/branch/assets/card/${ghostCard}/view`).expect(404);
    await auth(request(app).post(`/api/branch/assets/deck/${ghostDeck}/like`), me.token).expect(404);
    // 卡组的 key 必须是 ObjectId 串；不是的话直接丢给 Mongo 会 CastError 变 500
    await auth(request(app).post("/api/branch/assets/deck/not-an-objectid/like"), me.token).expect(404);

    // ★ 真正的判据：一行都没造出来。这几张表全是 upsert:true，
    //   放行的话一个循环就能灌出**任何 API 都读不到、也删不掉**的文档
    for (const Model of [BranchAssetStat, BranchAssetLike, BranchAssetView]) {
      expect(await Model.countDocuments({ key: { $in: [ghostCard, ghostDeck, "not-an-objectid"] } })).toBe(0);
    }
  });

  test("A9 浏览量去重：同一个访客同一天只算一次，换个人才 +1", async () => {
    const me = await registerUser();
    const other = await registerUser();
    const card = cardOf();
    await addCards(me.token, [card]).expect(201);
    const base = `/api/branch/assets/card/${card.cardId}`;

    // 匿名连打三次：客户端那份 sessionStorage 去重任何 HTTP 客户端都绕得过去，
    // 服务端不自己数就是没数
    const first = await request(app).post(`${base}/view`).expect(200);
    expect(first.body.stats.views).toBe(1);
    await request(app).post(`${base}/view`).expect(200);
    const third = await request(app).post(`${base}/view`).expect(200);
    // ★ 已经数过时照样 200：再打开一次详情页对用户来说本来就该是成功的
    expect(third.body.stats.views).toBe(1);

    // 换个访客（登录的算另一个人）才 +1，而且他自己重复打也只算一次
    const logged = await auth(request(app).post(`${base}/view`), me.token).expect(200);
    expect(logged.body.stats.views).toBe(2);
    const again = await auth(request(app).post(`${base}/view`), me.token).expect(200);
    expect(again.body.stats.views).toBe(2);
    const byOther = await auth(request(app).post(`${base}/view`), other.token).expect(200);
    expect(byOther.body.stats.views).toBe(3);

    // 去重表里存的不能是原始 IP（那是可直接识别到人的数据，而我们只需要"数过没有"）
    const BranchAssetView = require("../src/models/BranchAssetView");
    const rows = await BranchAssetView.find({ kind: "card", key: card.cardId }).lean();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.viewer).not.toMatch(/127\.0\.0\.1|::1|::ffff:/);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  test("A10 广场展示的那份和装到手的那份必须是同一个文档（最早发布的那份）", async () => {
    const firstPublisher = await registerUser();
    const secondPublisher = await registerUser();
    const taker = await registerUser();

    // 同一个 cardId 在库里是每人一份，各份的名字/封面/建模可以完全不一样。
    // ★★ 2026-08-30 起**发不出第二份**了（见下面的 A10b）——但库里可能有存量重复行
    //   （闸门上线之前发的），去重逻辑就是为它们存在的。所以这里绕过 API 直接造那种数据。
    const cardId = `mkt_same_card_${Date.now().toString(36)}`;
    await addCards(firstPublisher.token, [
      cardOf({ cardId, name: "先分享的那份", genPrompt: "原作者的蓝图" }),
    ]).expect(201);
    await addCards(secondPublisher.token, [
      cardOf({ cardId, name: "后分享的那份", genPrompt: "改过的蓝图" }),
    ]).expect(201);

    await request(app)
      .post(`/api/branch/cards/${cardId}/publish`)
      .set("Authorization", `Bearer ${firstPublisher.token}`)
      .expect(200);
    await new Promise((r) => setTimeout(r, 20)); // 让两条的 publishedAt 真的分得开
    // 存量重复行：直接改库（这正是闸门上线之前 API 会产出的形状）
    const BranchCard = require("../src/models/BranchCard");
    await BranchCard.updateOne(
      { cardId, name: "后分享的那份" },
      { $set: { published: true, publishedAt: new Date() } }
    );

    // 广场：只出现一条，且是**最早**分享的那份（谁先分享算谁的）
    const shared = await request(app).get("/api/branch/cards/shared").expect(200);
    const rows = shared.body.cards.filter((c) => c.cardId === cardId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("先分享的那份");
    expect(rows[0].author.username).toBeTruthy();

    // ★ 装到手的必须是同一份文档 —— 不然用户点开看的和装进库的是两张卡，且两次都 200
    const installed = await request(app)
      .post(`/api/branch/cards/${cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    expect(installed.body.card.name).toBe(rows[0].name);
    expect(installed.body.card.genPrompt).toBe(rows[0].genPrompt);
    expect(String(installed.body.card._id)).not.toBe(String(rows[0]._id)); // 是我自己那份副本
  });

  // ── 转发闸门（2026-08-30）────────────────────────────────────────
  //
  // ★★ 这是**产品语义变更**：从"库里任何一张卡都能挂上广场"改成"只有原创那份能挂"。
  //   理由是机制层面的 —— 卡片身份是全局 cardId，`{owner,cardId}` 唯一索引 + 广场按
  //   cardId 去重（最早发布那条）⇒ 转发**根本没有第二行可放**。此前那颗能点的按钮是个
  //   假承诺：推荐语进了库谁也看不见，广场那行仍是原作者的，而按钮翻成了成功态。
  test("A10b 装来的卡不能再分享一遍（两道闸各自独立成立）", async () => {
    const author = await registerUser();
    const taker = await registerUser();
    const card = cardOf({ name: "会被转发的卡" });
    await addCards(author.token, [card]).expect(201);
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    // 装走 → 库里那份带上了 sourceOwner
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);

    // 第一道闸：sourceOwner 有值 → 400，且**说清楚为什么**（不是一句 Bad Request）
    const refused = await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(400);
    expect(String(refused.body.message || refused.body.error || "")).toMatch(/装来的|最早/);

    // ★ 原作者自己**照常**能撤下、能再发（闸门只拦转发，不许误伤原创）
    await request(app)
      .delete(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
  });

  test("A10c 第二道闸：没有来源标记的快照卡，靠「已经有人先发过」拦住", async () => {
    // 跟着作品卡组 / 模板快照经 POST /cards 落库的卡没有 sourceOwner —— 服务端无从
    // 判断它是不是你原创的，但"广场上已经有别人先分享过同一个 cardId"是硬事实。
    const author = await registerUser();
    const other = await registerUser();
    const cardId = `mkt_snapshot_${Date.now().toString(36)}`;
    await addCards(author.token, [cardOf({ cardId, name: "原件" })]).expect(201);
    await addCards(other.token, [cardOf({ cardId, name: "手里的快照副本" })]).expect(201);

    await request(app)
      .post(`/api/branch/cards/${cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const refused = await request(app)
      .post(`/api/branch/cards/${cardId}/publish`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(400);
    expect(String(refused.body.message || refused.body.error || "")).toMatch(/已经有人先分享|最早/);
  });

  test("A11 卡组里有第三方版权模型：整个发布 400 并点名是哪张卡，不是悄悄剥掉", async () => {
    const author = await registerUser();
    const clean = cardOf({ name: "干净的卡" });
    const rin = cardOf({
      name: "凛",
      modelUrl: "https://cdn.example.com/models/protected/rin-player-opt.glbx",
    });
    await addCards(author.token, [clean, rin]).expect(201);

    const deck = (
      await request(app)
        .post("/api/branch/decks")
        .set("Authorization", `Bearer ${author.token}`)
        .send({ name: "混了版权素材的卡组", cardIds: [clean.cardId, rin.cardId] })
        .expect(201)
    ).body.deck;

    const res = await request(app)
      .post(`/api/branch/decks/${deck._id}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(400);
    // 一套卡十几张，不点名等于让用户挨个猜
    expect(res.body.message).toContain("凛");

    // 没有半发布状态：广场上不该出现它
    const shared = await request(app).get("/api/branch/decks/shared").expect(200);
    expect(shared.body.decks.some((d) => d._id === deck._id)).toBe(false);

    // 自有资产（委托定制的 milltina）住在同一个加密目录里，但不受此限
    const own = cardOf({ modelUrl: "https://cdn.example.com/models/protected/milltina-opt.glbx" });
    await addCards(author.token, [own]).expect(201);
    await request(app)
      .patch(`/api/branch/decks/${deck._id}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ cardIds: [clean.cardId, own.cardId] })
      .expect(200);
    await request(app)
      .post(`/api/branch/decks/${deck._id}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
  });

  // ── 多图参考（views）────────────────────────────────────────────
  // A12/A13 盯的是同一类【做错了不报错】的问题，只是这次的后果更隐蔽：
  // views 丢了不会让任何请求失败，只会让 AI 少拿到几张形象参考 ——
  // 生成出来的人物"有点不像"，用户只会觉得模型不稳，不会怀疑数据没存下来。
  test("A12 views 能存能读，并跟着分享/安装/卡组快照一起走", async () => {
    const author = await registerUser();
    const taker = await registerUser();

    const views = [
      { url: "https://cdn.example.com/hero-face.jpg", kind: "face", note: "面部特写" },
      { url: "https://cdn.example.com/hero-body.jpg", kind: "body" },
    ];
    const card = cardOf({ name: "带参考图的卡", views });
    const created = await addCards(author.token, [card]).expect(201);
    expect(created.body.cards[0].views).toHaveLength(2);
    // note 省了要有个空串兜底，别让客户端去判 undefined
    expect(created.body.cards[0].views[1]).toEqual({
      url: "https://cdn.example.com/hero-body.jpg",
      kind: "body",
      note: "",
    });

    // 回读：201 的回包可能只是内存里的对象，真正的判据是从库里查出来还在
    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(listed.body.cards.find((c) => c.cardId === card.cardId).views).toEqual([
      { url: "https://cdn.example.com/hero-face.jpg", kind: "face", note: "面部特写" },
      { url: "https://cdn.example.com/hero-body.jpg", kind: "body", note: "" },
    ]);

    // 广场上就要能看到（不然装回来才发现是两张卡）
    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    const shared = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(shared.body.cards.find((c) => c.cardId === card.cardId).views).toHaveLength(2);

    // 装走的那份也要带上 —— 少了它，装卡的人炼出来的人物不是同一个人
    const installed = await request(app)
      .post(`/api/branch/cards/${card.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    expect(installed.body.card.views.map((v) => v.url)).toEqual(views.map((v) => v.url));
  });

  // ★★ A12d 盯的是**灵活图位**（role/tag，2026-08-24）那条五处一起改的链子。
  //   漏任何一处都不会报错，只会让"提示词方案"做出来的卡在发布→装回之后**整份退回固定三格**：
  //   花名没了、display 位变成能进模型的 aux —— 画面因此变差（合成规格图当人物参考会加剧
  //   ID 漂移），而没有任何一处会说话。所以这条必须钉在**回读**与**装走**两个点上。
  test("A12d role/tag 存得下、读得回，并跟着分享/安装一起走", async () => {
    const author = await registerUser();
    const taker = await registerUser();

    const views = [
      { url: "https://cdn.example.com/s-face.jpg", kind: "face", role: "face", tag: "面部特写" },
      { url: "https://cdn.example.com/s-sheet.jpg", kind: "detail", role: "display", tag: "无面部白模三视图" },
    ];
    const card = cardOf({ name: "方案卡", views });
    await addCards(author.token, [card]).expect(201);

    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(listed.body.cards.find((c) => c.cardId === card.cardId).views).toEqual([
      { url: "https://cdn.example.com/s-face.jpg", kind: "face", role: "face", tag: "面部特写", note: "" },
      { url: "https://cdn.example.com/s-sheet.jpg", kind: "detail", role: "display", tag: "无面部白模三视图", note: "" },
    ]);

    await request(app)
      .post(`/api/branch/cards/${card.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    const installed = await request(app)
      .post(`/api/branch/cards/${card.cardId}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    // 装走那份尤其要紧：display 位一旦退成 aux，装卡的人出片时它就真进模型了
    expect(installed.body.card.views.map((v) => [v.role, v.tag])).toEqual([
      ["face", "面部特写"],
      ["display", "无面部白模三视图"],
    ]);
  });

  // 老卡（不带 role/tag）必须**一个字段都不多长出来**：缺省的语义是"按 kind 推"，
  // 服务端补一个默认值就是第二处推法，两边一旦分叉就是静默错配（所以这条也钉住）。
  test("A12e 不带 role/tag 的老卡回读时不会被补上默认值", async () => {
    const author = await registerUser();
    const card = cardOf({ name: "老卡", views: [{ url: "https://cdn.example.com/old.jpg", kind: "body" }] });
    await addCards(author.token, [card]).expect(201);
    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(listed.body.cards.find((c) => c.cardId === card.cardId).views).toEqual([
      { url: "https://cdn.example.com/old.jpg", kind: "body", note: "" },
    ]);
  });

  // ★★ 肖像闸门（2026-08-27）。这条是**产品决定**落到代码里的那一份：卡上那张脸是某个
  //   真实的人，他同意的是"卡主拿去做视频"，不是"挂到广场任人取用"。漏了它的表现不是
  //   报错，而是**真人卡真的被发布出去了** —— 而受害的是一个不在场、也不知情的人。
  test("A14 声明过真人的卡不能发布到广场（卡片与卡组两条路都拦）", async () => {
    const author = await registerUser();

    const real = cardOf({ name: "真人卡", realPerson: true });
    const normal = cardOf({ name: "普通卡" });
    await addCards(author.token, [real, normal]).expect(201);

    // ① 卡片：整发 400，且**不能**悄悄发布出去
    const denied = await request(app)
      .post(`/api/branch/cards/${real.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(400);
    expect(String(denied.body.message || denied.body.error || "")).toContain("真实人物");

    const shared = await request(app).get("/api/branch/cards/shared").expect(200);
    expect(shared.body.cards.find((c) => c.cardId === real.cardId)).toBeUndefined();

    // 同一个账号的普通卡照常发得出去（闸只拦该拦的）
    await request(app)
      .post(`/api/branch/cards/${normal.cardId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    // ② 卡组：组里有一张真人卡就整组拒，并**点名是哪一张**
    const deck = await request(app)
      .post("/api/branch/decks")
      .set("Authorization", `Bearer ${author.token}`)
      .send({ name: "混着真人卡的组", cardIds: [normal.cardId, real.cardId] })
      .expect(201);
    const deckId = deck.body.deck.id || deck.body.deck._id;
    const deckDenied = await request(app)
      .post(`/api/branch/decks/${deckId}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(400);
    expect(String(deckDenied.body.message || deckDenied.body.error || "")).toContain("真人卡");

    const sharedDecks = await request(app).get("/api/branch/decks/shared").expect(200);
    expect(sharedDecks.body.decks.find((d) => String(d.id || d._id) === String(deckId))).toBeUndefined();
  });

  test("A12b 卡组快照里带得上 views（modelUrl 当年就是快照那份漏了声明）", async () => {
    const author = await registerUser();
    const taker = await registerUser();

    const card = cardOf({
      name: "卡组里的角色",
      views: [{ url: "https://cdn.example.com/deck-face.jpg", kind: "face" }],
    });
    await addCards(author.token, [card]).expect(201);

    const deck = (
      await request(app)
        .post("/api/branch/decks")
        .set("Authorization", `Bearer ${author.token}`)
        .send({ name: "带参考图的卡组", cardIds: [card.cardId] })
        .expect(201)
    ).body.deck;
    await request(app)
      .post(`/api/branch/decks/${deck._id}/publish`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const installed = await request(app)
      .post(`/api/branch/decks/${deck._id}/install`)
      .set("Authorization", `Bearer ${taker.token}`)
      .expect(201);
    const got = installed.body.cards.find((c) => c.cardId === card.cardId);
    expect(got.views).toEqual([{ url: "https://cdn.example.com/deck-face.jpg", kind: "face", note: "" }]);
  });

  test("A12c PATCH /cards/:cardId 真的改得动 views（POST /cards 是 $setOnInsert，改不动）", async () => {
    const me = await registerUser();
    const card = cardOf({ name: "要改参考图的卡" });
    await addCards(me.token, [card]).expect(201);

    // ★ 先证明"拿 POST 去改"是无效的 —— 这正是 PATCH 必须存在的理由：
    //   $setOnInsert 只在插入时生效，改卡会 201 得漂漂亮亮、库里一个字节没变。
    await addCards(me.token, [{ ...card, views: [{ url: "https://cdn.example.com/x.jpg", kind: "face" }] }]).expect(201);
    const afterPost = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    expect(afterPost.body.cards.find((c) => c.cardId === card.cardId).views).toEqual([]);

    const patched = await request(app)
      .patch(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ views: [{ url: "https://cdn.example.com/face.jpg", kind: "face", note: "大头照" }] })
      .expect(200);
    expect(patched.body.card.views).toEqual([
      { url: "https://cdn.example.com/face.jpg", kind: "face", note: "大头照" },
    ]);

    // 回读才算数：201/200 的回包可能只是内存里的对象
    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    expect(listed.body.cards.find((c) => c.cardId === card.cardId).views).toHaveLength(1);

    // 清空也要存得下（"这张卡明确地不要参考图"）
    await request(app)
      .patch(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ views: [] })
      .expect(200);
    const cleared = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    expect(cleared.body.cards.find((c) => c.cardId === card.cardId).views).toEqual([]);

    // 别人的卡 / 不存在的卡：404 而不是 200 假装存上了（客户端据此显红字）
    const other = await registerUser();
    await request(app)
      .patch(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ views: [] })
      .expect(404);
    // 越界的 views 在这条路上同样是 400，与 POST 同一套规则
    await request(app)
      .patch(`/api/branch/cards/${card.cardId}`)
      .set("Authorization", `Bearer ${me.token}`)
      .send({ views: [{ url: "idb:local", kind: "body" }] })
      .expect(400);
  });

  test("A13 超过 3 张 / dataURL / idb: 一律 400，而且一行都不落库", async () => {
    const me = await registerUser();

    // ① 上限 3（方舟指南：素材堆满反而让模型分不清特征优先级）。
    //    ★ 必须是 400 而不是"悄悄截断"：截断的话用户挂了 4 张、界面显示 3 张，
    //      他只会以为自己少点了一下。
    const tooMany = cardOf({
      views: [1, 2, 3, 4].map((i) => ({ url: `https://cdn.example.com/v${i}.jpg`, kind: "detail" })),
    });
    await addCards(me.token, [tooMany]).expect(400);

    // ② dataURL：一张卡三张 base64 会把卡组快照撑爆，客户端必须先转存成永久 URL
    const inlined = cardOf({
      views: [{ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=", kind: "body" }],
    });
    await addCards(me.token, [inlined]).expect(400);

    // ③ 设备本地指针：别人（以及换台设备的本人）拿到就是死链，而死链不报错
    const local = cardOf({ views: [{ url: `idb:cardview:${Date.now()}`, kind: "body" }] });
    await addCards(me.token, [local]).expect(400);

    // 真正的判据：三张卡一张都没进库（zod 是整批拒，不是"坏的那张跳过"）
    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const ids = new Set(listed.body.cards.map((c) => c.cardId));
    for (const bad of [tooMany, inlined, local]) expect(ids.has(bad.cardId)).toBe(false);
  });

  test("A13b 老卡（没有 views）读回来是空数组，服务端不替客户端补 cover 那一张", async () => {
    // ★ 「老卡 = 拿封面当唯一一张形象参考」这条归一只在 app 的 viewsOf() 一处做。
    //   服务端也补一份的话就是同一条规则的第二处实现，两边一旦分叉，
    //   用户看到的参考图和真正喂给 AI 的那批会不是同一批，且看不出来。
    const me = await registerUser();
    const card = cardOf({ cover: "https://cdn.example.com/only-cover.jpg" });
    await addCards(me.token, [card]).expect(201);

    const listed = await request(app)
      .get("/api/branch/cards")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    const back = listed.body.cards.find((c) => c.cardId === card.cardId);
    expect(back.views).toEqual([]);
    expect(back.cover).toBe("https://cdn.example.com/only-cover.jpg");
  });

  test("A7 卡组也有热度，且与卡片各算各的（key 不共用一个命名空间）", async () => {
    const me = await registerUser();
    const card = cardOf({ cardId: `shared_key_${Date.now().toString(36)}` });
    await addCards(me.token, [card]).expect(201);
    const deck = (
      await request(app)
        .post("/api/branch/decks")
        .set("Authorization", `Bearer ${me.token}`)
        .send({ name: "热度卡组", cardIds: [card.cardId] })
        .expect(201)
    ).body.deck;

    await auth(request(app).post(`/api/branch/assets/deck/${deck._id}/like`), me.token).expect(200);

    const decks = await request(app)
      .get("/api/branch/decks")
      .set("Authorization", `Bearer ${me.token}`)
      .expect(200);
    expect(decks.body.decks.find((d) => d._id === deck._id).stats.heat).toBe(6);

    // 同名 key 在 card 命名空间下仍然是 0
    const cardStats = await request(app).get(`/api/branch/assets/card/${deck._id}/stats`).expect(200);
    expect(cardStats.body.stats.heat).toBe(0);
  });
});
