// tests/branchRecipe.spec.js
// 覆盖：已发布作品的「公开配方」（制作过程）—— /api/branch/videos/:id/recipe 四条端点，
// 以及作品回包上的提示位（recipePublic / recipeState）与同款归属（remixOf / remixCount）。
//
// ★ 这套用例盯的是六类【做错了不报错】的问题：
//   R1 白名单：配方会公开给所有人。未声明的键（没选中的方案、圈选、原话草稿）必须落不了库 ——
//      放行的表现是"别人看得到作者没打算公开的东西"，而作者那头零提示。
//   R2 红线：真人卡 / 装来的卡 / 本机地址一律 400。
//   R3 归属与可见：只有作者能写；别人只读得到「公开 + 描述的正是当下这一版」的；读不到作品的人一律 404。
//   R4 版次：回炉之后旧配方自动对别人不可见（作品页那颗键跟着熄），不需要任何人去改它。
//   R5 级联：删作品与删号**两处都要**把配方带走。
//   R6 同款：remixOf 认不下来不挡发布；计数只数别人的、公开可见的。
//   L（2026-10-02 模板体系 P2）工作流模板 = 上了架的公开配方：
//      L1 上架位随 PUT / PATCH 走，货架端点只列「上架 + 公开 + 不过期 + 作品对这个人可读」的；
//      L2 不公开 / 过期的不许上架（400），关公开顺手下架，回炉后从货架上消失；
//      L3 被公开配方引用着的段模板作者只能「退役」：删除 / 下架都落成 retired、素材不回收、所有人照样读得到；
//         引用没了之后再删才真删。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let BranchRecipe;
let BranchVideo;
let BranchCard;
let BranchTemplate;
let User;
let cloudinary;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchRecipe = require("../src/models/BranchRecipe");
  BranchVideo = require("../src/models/BranchVideo");
  BranchCard = require("../src/models/BranchCard");
  BranchTemplate = require("../src/models/BranchTemplate");
  User = require("../src/models/User");
  ({ cloudinary } = require("../src/config/cloudinary"));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `rc${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), name };
}

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

async function publish(u, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set(auth(u))
    .send({
      title: "配方测试作品",
      category: "剧情",
      segments: [{ title: "成片", plot: "合并后的一整段", videoUrl: "https://cdn.example.com/m.mp4", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

const IMG = "https://res.cloudinary.com/demo/image/upload/ideahub/branch-frames/a.jpg";

/** 一份合规的配方：两段，带一张卡、一个空位、一个段模板回指 */
function recipeOf(over = {}) {
  return {
    v: 1,
    mode: "workflow",
    nodes: [
      {
        title: "第 1 段 · 雨夜",
        plot: "镜头：近景 · 推。信使在雨里收到一封没有地址的信",
        shot: { size: "近景", camera: "推", beat: "压抑" },
        durationSec: 5,
        tier: "hd",
        model: "doubao-seedance-2-0-mini-260615",
        aspect: "portrait",
        chain: false,
        kind: "classic",
        cards: ["card_hero"],
        slots: [0],
        preview: { first: IMG, last: IMG },
      },
      {
        title: "第 2 段 · 复刻",
        plot: "最左边=凛",
        durationSec: 8,
        tier: "ultra",
        aspect: "portrait",
        chain: false,
        kind: "blockout",
        cards: [],
        slots: [],
        tpl: { id: "a".repeat(24), title: "雨夜递伞", part: { index: 0, count: 2 } },
        flags: ["stage"],
      },
    ],
    deck: [
      {
        cardId: "card_hero",
        type: "character",
        name: "凛",
        summary: "信使",
        cover: IMG,
        tags: ["信使"],
        idLine: "黑色长发，红色上衣",
        views: [{ url: IMG, kind: "body" }],
      },
    ],
    cast: [{ type: "character", why: "real", name: "不该留下的名字" }],
    ...over,
  };
}

const putRecipe = (u, videoId, body) => request(app).put(`/api/branch/videos/${videoId}/recipe`).set(auth(u)).send(body);
const getRecipe = (u, videoId) => {
  const r = request(app).get(`/api/branch/videos/${videoId}/recipe`);
  return u ? r.set(auth(u)) : r;
};
const getVideo = (u, videoId) => {
  const r = request(app).get(`/api/branch/videos/${videoId}`);
  return u ? r.set(auth(u)) : r;
};

async function reviseOnce(u, videoId, baseRevision = 0) {
  await request(app)
    .patch(`/api/branch/videos/${videoId}`)
    .set(auth(u))
    .send({ baseRevision, segments: [{ title: "回炉过的段", videoUrl: "https://cdn.example.com/r.mp4" }] })
    .expect(200);
}

describe("公开配方：写入与白名单", () => {
  test("R1 正常留存 → 200；别人（含没登录的）读得到；作品回包亮起 recipePublic", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author);

    // 留存之前：谁都没有这颗键
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
    await getRecipe(viewer, videoId).expect(404);

    const res = await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    expect(res.body.recipe.public).toBe(true);
    expect(res.body.recipe.stale).toBe(false);
    expect(res.body.recipe.nodeCount).toBe(2);

    for (const who of [viewer, null]) {
      const got = await getRecipe(who, videoId).expect(200);
      expect(got.body.recipe.nodes).toHaveLength(2);
      expect(got.body.recipe.nodes[0].shot).toEqual({ size: "近景", camera: "推", beat: "压抑" });
      expect(got.body.recipe.nodes[1].tpl.id).toBe("a".repeat(24));
      expect(got.body.meta.isOwner).toBe(false);
      expect(got.body.meta.title).toBe("配方测试作品");
      expect(got.body.meta.author.displayName).toBeTruthy();
      expect((await getVideo(who, videoId).expect(200)).body.video.recipePublic).toBe(true);
    }
    // 列表回包同样带这颗提示位（首页 / 个人页不必为每条作品再问一次）
    const list = await request(app).get("/api/branch/videos").expect(200);
    expect(list.body.items.find((v) => String(v._id) === videoId).recipePublic).toBe(true);
    // 作者另看得到开关的现状
    const mine = await getVideo(author, videoId).expect(200);
    expect(mine.body.video.recipeState).toEqual({ public: true, stale: false, listed: false });
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipeState).toBeUndefined();
  });

  test("R1 未声明的键落不了库：没选中的方案 / 圈选 / 原话 / 卡主私有字段 一样都出不去", async () => {
    const author = await registerUser();
    const videoId = await publish(author);
    const dirty = recipeOf();
    dirty.nodes[0].proposals = [{ plot: "没选中的那一套" }];
    dirty.nodes[0].anns = [{ text: "圈选标注" }];
    dirty.nodes[0].requirement = "用户的原话草稿";
    dirty.nodes[0].steps = [{ label: "出片日志" }];
    dirty.deck[0].genPrompt = "卡主私有的生成提示词";
    dirty.deck[0].modelUrl = "https://example.com/model.glb";
    dirty.secret = "顶层多出来的键";

    await putRecipe(author, videoId, { recipe: dirty, videoRevision: 0 }).expect(200);

    const stored = (await BranchRecipe.findOne({ video: videoId }).lean()).recipe;
    const text = JSON.stringify(stored);
    for (const leak of ["没选中的那一套", "圈选标注", "用户的原话草稿", "出片日志", "卡主私有的生成提示词", "model.glb", "顶层多出来的键"]) {
      expect(text).not.toContain(leak);
    }
    // 真人空位的名字服务端再抹一遍（客户端投影本来就不该带）
    expect(stored.cast[0]).toEqual({ type: "character", why: "real", name: "" });
    // bytes 是服务端按**存下来的那份**量的
    expect((await BranchRecipe.findOne({ video: videoId }).lean()).bytes).toBe(Buffer.byteLength(text));
  });

  test("R2 红线：本机地址 / 标着真人的卡 / 悬空引用 / 重复的卡 → 400，一个字都不落库", async () => {
    const author = await registerUser();
    const videoId = await publish(author);

    const local = recipeOf();
    local.nodes[0].preview.first = "data:image/png;base64,AAAA";
    await putRecipe(author, videoId, { recipe: local, videoRevision: 0 }).expect(400);

    const ark = recipeOf();
    ark.deck[0].cover = "https://ark-content.tos-cn-beijing.volces.com/x.jpg";
    await putRecipe(author, videoId, { recipe: ark, videoRevision: 0 }).expect(400);

    const real = recipeOf();
    real.deck[0].realPerson = true;
    await putRecipe(author, videoId, { recipe: real, videoRevision: 0 }).expect(400);

    const dangling = recipeOf();
    dangling.nodes[0].cards = ["card_not_in_deck"];
    await putRecipe(author, videoId, { recipe: dangling, videoRevision: 0 }).expect(400);

    const badSlot = recipeOf();
    badSlot.nodes[0].slots = [5];
    await putRecipe(author, videoId, { recipe: badSlot, videoRevision: 0 }).expect(400);

    const dup = recipeOf();
    dup.deck.push({ ...dup.deck[0] });
    await putRecipe(author, videoId, { recipe: dup, videoRevision: 0 }).expect(400);

    const badTpl = recipeOf();
    badTpl.nodes[1].tpl.id = "tpl_local_id";
    await putRecipe(author, videoId, { recipe: badTpl, videoRevision: 0 }).expect(400);

    expect(await BranchRecipe.countDocuments({ video: videoId })).toBe(0);
    expect((await getVideo(author, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
  });

  test("R2 按作者的卡库再核一遍：库里标着真人的卡、装来的卡，客户端没带标记也过不去", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const videoId = await publish(author);

    await BranchCard.create({ owner: author.userId, cardId: "card_hero", type: "character", name: "凛", realPerson: true });
    const r1 = await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(400);
    expect(r1.body.code).toBe("RECIPE_REAL_PERSON");
    expect(typeof r1.body.message).toBe("string");

    await BranchCard.updateOne({ owner: author.userId, cardId: "card_hero" }, { $set: { realPerson: false, sourceOwner: other.userId } });
    const r2 = await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(400);
    expect(r2.body.code).toBe("RECIPE_FOREIGN_CARD");

    // 自己原创的普通卡：放行
    await BranchCard.updateOne({ owner: author.userId, cardId: "card_hero" }, { $unset: { sourceOwner: "" } });
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
  });
});

describe("公开配方：归属、开关与可见", () => {
  test("R3 只有作者能写：别人 PUT / PATCH / DELETE 都是 403，没登录是 401", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);

    await putRecipe(other, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(403);
    await request(app).patch(`/api/branch/videos/${videoId}/recipe`).set(auth(other)).send({ public: false }).expect(403);
    await request(app).delete(`/api/branch/videos/${videoId}/recipe`).set(auth(other)).expect(403);
    await request(app).put(`/api/branch/videos/${videoId}/recipe`).send({ recipe: recipeOf(), videoRevision: 0 }).expect(401);
    // 别人这一通折腾之后，配方原样还在、还是公开的
    expect((await getRecipe(other, videoId).expect(200)).body.recipe.nodes).toHaveLength(2);
  });

  test("R3 作者关掉公开：别人 404、作品页那颗键熄掉；作者自己照样读得到；再打开又回来", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);

    const off = await request(app).patch(`/api/branch/videos/${videoId}/recipe`).set(auth(author)).send({ public: false }).expect(200);
    expect(off.body.recipe.public).toBe(false);
    const denied = await getRecipe(viewer, videoId).expect(404);
    expect(denied.body.code).toBe("RECIPE_NOT_PUBLIC");
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
    const mine = await getRecipe(author, videoId).expect(200);
    expect(mine.body.meta.public).toBe(false);
    expect(mine.body.meta.isOwner).toBe(true);
    expect((await getVideo(author, videoId).expect(200)).body.video.recipeState).toEqual({ public: false, stale: false, listed: false });

    await request(app).patch(`/api/branch/videos/${videoId}/recipe`).set(auth(author)).send({ public: true }).expect(200);
    await getRecipe(viewer, videoId).expect(200);
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBe(true);
  });

  test("R3 留存时直接带 public:false：存上了，但从头到尾不对别人公开", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0, public: false }).expect(200);
    await getRecipe(viewer, videoId).expect(404);
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
    await getRecipe(author, videoId).expect(200);
  });

  test("R3 没有配方时：PATCH 是 404 RECIPE_NOT_FOUND（打开之前要先留存一份）；作者 GET 也是这一句", async () => {
    const author = await registerUser();
    const videoId = await publish(author);
    const p = await request(app).patch(`/api/branch/videos/${videoId}/recipe`).set(auth(author)).send({ public: true }).expect(404);
    expect(p.body.code).toBe("RECIPE_NOT_FOUND");
    expect((await getRecipe(author, videoId).expect(404)).body.code).toBe("RECIPE_NOT_FOUND");
  });

  test("R3 读不到作品的人读不到配方：私密作品 404；凭链接可见的放行；被下架的对别人 404", async () => {
    const author = await registerUser();
    const viewer = await registerUser();

    const priv = await publish(author, { visibility: "private" });
    await putRecipe(author, priv, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    await getRecipe(viewer, priv).expect(404);
    await getRecipe(null, priv).expect(404);
    await getRecipe(author, priv).expect(200);

    const link = await publish(author, { visibility: "private", linkOnly: true });
    await putRecipe(author, link, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    await getRecipe(viewer, link).expect(200);

    const down = await publish(author);
    await putRecipe(author, down, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    await getRecipe(viewer, down).expect(200);
    await BranchVideo.updateOne({ _id: down }, { $set: { takedown: { by: viewer.userId, at: new Date(), reason: "测试下架" } } });
    await getRecipe(viewer, down).expect(404);
    await getRecipe(author, down).expect(200);
  });

  test("作者删掉配方：正文与作品上的提示位一起没了", async () => {
    const author = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    await request(app).delete(`/api/branch/videos/${videoId}/recipe`).set(auth(author)).expect(200);
    expect(await BranchRecipe.countDocuments({ video: videoId })).toBe(0);
    const v = (await getVideo(author, videoId).expect(200)).body.video;
    expect(v.recipePublic).toBeUndefined();
    expect(v.recipeState).toBeUndefined();
  });
});

describe("公开配方：版次", () => {
  test("R4 videoRevision 对不上作品当下的版次 → 400 RECIPE_REVISION_MISMATCH（带 currentRevision）", async () => {
    const author = await registerUser();
    const videoId = await publish(author);
    const res = await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 3 }).expect(400);
    expect(res.body.code).toBe("RECIPE_REVISION_MISMATCH");
    expect(res.body.details.currentRevision).toBe(0);
    expect(await BranchRecipe.countDocuments({ video: videoId })).toBe(0);
  });

  test("R4 回炉之后旧配方自动对别人不可见、作品页的键熄掉；作者换上新一版之后才回来", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBe(true);

    await reviseOnce(author, videoId, 0);

    // 没有任何人去改配方那张表，它就已经不可见了（判据是"描述的是不是当下这一版"）
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
    expect((await getRecipe(viewer, videoId).expect(404)).body.code).toBe("RECIPE_NOT_PUBLIC");
    const mine = await getRecipe(author, videoId).expect(200);
    expect(mine.body.meta.stale).toBe(true);
    expect((await getVideo(author, videoId).expect(200)).body.video.recipeState).toEqual({ public: true, stale: true, listed: false });
    // 拿上一版的版次再留存 → 拒
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(400);

    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 1 }).expect(200);
    expect((await getVideo(viewer, videoId).expect(200)).body.video.recipePublic).toBe(true);
    expect((await getRecipe(viewer, videoId).expect(200)).body.meta.videoRevision).toBe(1);
  });
});

describe("公开配方：级联", () => {
  test("R5 删作品把配方一起带走", async () => {
    const author = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    await request(app).delete(`/api/branch/videos/${videoId}`).set(auth(author)).expect(200);
    expect(await BranchRecipe.countDocuments({ video: videoId })).toBe(0);
  });

  test("R5 删号（purgeUserCascade）把配方一起带走（含作品早已不在的孤儿）", async () => {
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const author = await registerUser();
    const keeper = await registerUser();
    const videoId = await publish(author);
    await putRecipe(author, videoId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);
    // 一条孤儿：作品不在了、配方行还留着（模拟历史数据）
    await BranchRecipe.create({ owner: author.userId, video: new mongoose.Types.ObjectId(), recipe: recipeOf(), videoRevision: 0 });
    // 别人的那份不许被误删
    const keepId = await publish(keeper);
    await putRecipe(keeper, keepId, { recipe: recipeOf(), videoRevision: 0 }).expect(200);

    const removed = await purgeUserCascade(author.userId);
    expect(await BranchRecipe.countDocuments({ owner: author.userId })).toBe(0);
    expect(removed.recipes).toBe(1); // 挂在作品上的那份已随 purgeVideo 走了，这里收的是孤儿
    expect(await BranchRecipe.countDocuments({ owner: keeper.userId })).toBe(1);
  });
});

describe("工作流模板：上架与货架", () => {
  const listWorkflows = (u) => {
    const r = request(app).get("/api/branch/templates/workflows");
    return u ? r.set(auth(u)) : r;
  };
  const patchRecipe = (u, videoId, body) => request(app).patch(`/api/branch/videos/${videoId}/recipe`).set(auth(u)).send(body);

  test("L1 PUT 带 listed:true → 上架；货架端点（没登录也行）列出它，带摘要与作者；作者的作品回包 recipeState.listed", async () => {
    const a = await registerUser();
    const v = await publish(a, { title: "上架的那条" });
    const put = await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: true, listed: true }).expect(200);
    expect(put.body.recipe).toMatchObject({ public: true, listed: true, stale: false });
    const list = await listWorkflows(null).expect(200);
    const hit = list.body.items.find((i) => String(i.video) === v);
    expect(hit).toBeTruthy();
    expect(hit).toMatchObject({
      title: "上架的那条",
      author: { username: a.name },
      summary: { segs: 2, totalSec: 13, tiers: ["hd", "ultra"], templated: 1, cards: 1, slots: 1 },
      remixCount: 0,
    });
    // 货架不带正文
    expect(hit.recipe).toBeUndefined();
    const mine = await getVideo(a, v).expect(200);
    expect(mine.body.video.recipeState).toEqual({ public: true, stale: false, listed: true });
    // 别人的回包上没有 recipeState（那是作者的开关），recipePublic 照亮
    const theirs = await getVideo(null, v).expect(200);
    expect(theirs.body.video.recipeState).toBeUndefined();
    expect(theirs.body.video.recipePublic).toBe(true);
  });

  test("L1 不带 listed 的 PUT 不动原来的上架位（回炉重投一份配方不该悄悄下架）；PATCH listed 可上可下", async () => {
    const a = await registerUser();
    const v = await publish(a);
    await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: true, listed: true }).expect(200);
    const again = await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: true }).expect(200);
    expect(again.body.recipe.listed).toBe(true);
    const off = await patchRecipe(a, v, { listed: false }).expect(200);
    expect(off.body.recipe.listed).toBe(false);
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(false);
    const on = await patchRecipe(a, v, { listed: true }).expect(200);
    expect(on.body.recipe.listed).toBe(true);
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(true);
    // 空 PATCH 什么都不给 → 400
    await patchRecipe(a, v, {}).expect(400);
  });

  test("L2 没公开的不许上架（400 RECIPE_NOT_LISTABLE）；PUT 时勾了上架没勾公开 = 不上架；关公开顺手下架", async () => {
    const a = await registerUser();
    const v = await publish(a);
    const put = await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: false, listed: true }).expect(200);
    expect(put.body.recipe).toMatchObject({ public: false, listed: false });
    const res = await patchRecipe(a, v, { listed: true }).expect(400);
    expect(res.body.code).toBe("RECIPE_NOT_LISTABLE");
    await patchRecipe(a, v, { public: true, listed: true }).expect(200);
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(true);
    const closed = await patchRecipe(a, v, { public: false }).expect(200);
    expect(closed.body.recipe).toMatchObject({ public: false, listed: false });
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(false);
    const flag = await BranchVideo.findById(v).select("recipe").lean();
    expect(flag.recipe).toMatchObject({ public: false, listed: false });
  });

  test("L2 回炉之后从货架上消失（配方过期），过期时不许上架；重投新一版后回来", async () => {
    const a = await registerUser();
    const v = await publish(a);
    await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: true, listed: true }).expect(200);
    await reviseOnce(a, v, 0);
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(false);
    // 过期的那份再 PATCH listed:true（先下架再上）→ 400
    await patchRecipe(a, v, { listed: false }).expect(200);
    const res = await patchRecipe(a, v, { listed: true }).expect(400);
    expect(res.body.code).toBe("RECIPE_NOT_LISTABLE");
    await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 1, public: true, listed: true }).expect(200);
    expect((await listWorkflows(null).expect(200)).body.items.some((i) => String(i.video) === v)).toBe(true);
  });

  test("L1 货架按作品可读性筛：私密的不列（作者自己看得到）、凭链接可见的列、被下架的不列", async () => {
    const a = await registerUser();
    const priv = await publish(a, { visibility: "private" });
    const link = await publish(a, { visibility: "private", linkOnly: true });
    const down = await publish(a);
    for (const v of [priv, link, down]) await putRecipe(a, v, { recipe: recipeOf(), videoRevision: 0, public: true, listed: true }).expect(200);
    await BranchVideo.updateOne({ _id: down }, { $set: { takedown: { at: new Date(), reason: "test" } } });
    const anon = (await listWorkflows(null).expect(200)).body.items.map((i) => String(i.video));
    expect(anon).toContain(link);
    expect(anon).not.toContain(priv);
    expect(anon).not.toContain(down);
    const mine = (await listWorkflows(a).expect(200)).body.items.map((i) => String(i.video));
    expect(mine).toContain(priv);
  });
});

describe("工作流模板：被引用的段模板只能退役", () => {
  const TPL_URL = (n) => `https://res.cloudinary.com/demo/video/upload/v1712000000/ideahub/template-videos/retire-${n}.mp4`;
  async function seedTemplate(owner, n, status = "published") {
    return BranchTemplate.create({
      ownerId: owner.userId,
      title: `段模板 ${n}`,
      recipe: { beats: ["一段"], durationSec: 5 },
      refVideo: { url: TPL_URL(n), durationSec: 5, width: 720, height: 1280, bytes: 1000, cloudinaryPublicId: `ideahub/template-videos/retire-${n}` },
      status,
    });
  }
  const getTemplate = (u, id) => {
    const r = request(app).get(`/api/branch/templates/${id}`);
    return u ? r.set(auth(u)) : r;
  };
  let destroySpy;
  beforeEach(() => {
    destroySpy = jest.spyOn(cloudinary.uploader, "destroy").mockResolvedValue({ result: "ok" });
  });
  afterEach(() => destroySpy.mockRestore());

  test("L3 删除被公开配方引用的模板 → 退役（200 retired + 引用数），素材一个都不回收，没登录也读得到；引用没了再删才真删", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author, 1);
    const b = await registerUser();
    const v = await publish(b);
    const rec = recipeOf();
    rec.nodes[1].tpl = { id: String(tpl._id), title: "段模板 1" };
    await putRecipe(b, v, { recipe: rec, videoRevision: 0, public: true }).expect(200);

    const del = await request(app).delete(`/api/branch/templates/${tpl._id}`).set(auth(author)).expect(200);
    expect(del.body).toEqual({ ok: true, retired: true, refs: 1 });
    expect(destroySpy).not.toHaveBeenCalled();
    expect((await BranchTemplate.findById(tpl._id).lean()).status).toBe("retired");
    // 退役的对所有人可读（复制流程的人要靠它铺白模段）；不在市场货架上
    const anon = await getTemplate(null, tpl._id).expect(200);
    expect(anon.body.template.status).toBe("retired");
    const shared = await request(app).get("/api/branch/templates/shared").expect(200);
    expect(shared.body.templates.some((t) => t.id === String(tpl._id))).toBe(false);

    // 引用它的配方关了公开 → 引用数归零 → 再删一次真删、素材回收
    await request(app).patch(`/api/branch/videos/${v}/recipe`).set(auth(b)).send({ public: false }).expect(200);
    const del2 = await request(app).delete(`/api/branch/templates/${tpl._id}`).set(auth(author)).expect(200);
    expect(del2.body).toEqual({ ok: true });
    expect(destroySpy).toHaveBeenCalled();
    expect(await BranchTemplate.findById(tpl._id).lean()).toBeNull();
  });

  test("L3 作者「下架」被引用的模板 → 退役而不是回 pending；没人引用时照旧回 pending", async () => {
    const author = await registerUser();
    const used = await seedTemplate(author, 2);
    const idle = await seedTemplate(author, 3);
    const b = await registerUser();
    const v = await publish(b);
    const rec = recipeOf();
    rec.nodes[1].tpl = { id: String(used._id), title: "段模板 2" };
    await putRecipe(b, v, { recipe: rec, videoRevision: 0, public: true }).expect(200);

    const r1 = await request(app).patch(`/api/branch/templates/${used._id}/unpublish`).set(auth(author)).expect(200);
    expect(r1.body).toMatchObject({ ok: true, retired: true, refs: 1 });
    expect(r1.body.template.status).toBe("retired");
    const r2 = await request(app).patch(`/api/branch/templates/${idle._id}/unpublish`).set(auth(author)).expect(200);
    expect(r2.body.retired).toBeUndefined();
    expect(r2.body.template.status).toBe("pending");
    // pending 的对别人仍然 404（这条边界不变）
    await getTemplate(null, idle._id).expect(404);
  });

  test("L3 平台已下架（blocked）的模板，删除时不会被洗成 retired", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author, 4, "blocked");
    const b = await registerUser();
    const v = await publish(b);
    const rec = recipeOf();
    rec.nodes[1].tpl = { id: String(tpl._id), title: "段模板 4" };
    await putRecipe(b, v, { recipe: rec, videoRevision: 0, public: true }).expect(200);
    await request(app).delete(`/api/branch/templates/${tpl._id}`).set(auth(author)).expect(200);
    expect((await BranchTemplate.findById(tpl._id).lean()).status).toBe("blocked");
    await getTemplate(null, tpl._id).expect(404);
  });
});

describe("同款：归属与计数", () => {
  test("R6 发布带 remixOf：详情里带出「按谁的流程做的」，原作的同款数 +1；作者自己做的不算", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const src = await publish(author);

    expect((await getVideo(fan, src).expect(200)).body.video.remixCount).toBe(0);

    const remix = await publish(fan, { title: "我的同款", remixOf: src });
    const got = (await getVideo(null, remix).expect(200)).body.video;
    expect(String(got.remixOf.id)).toBe(src);
    expect(got.remixOf.title).toBe("配方测试作品");
    expect(String(got.remixOf.author._id)).toBe(author.userId);

    expect((await getVideo(fan, src).expect(200)).body.video.remixCount).toBe(1);
    // 作者照着自己的流程又做一条：不算"有人做了同款"
    await publish(author, { title: "自己再做一条", remixOf: src });
    expect((await getVideo(fan, src).expect(200)).body.video.remixCount).toBe(1);
    // 私密的同款不计数
    await publish(await registerUser(), { title: "私密同款", remixOf: src, visibility: "private" });
    expect((await getVideo(fan, src).expect(200)).body.video.remixCount).toBe(1);
    // 列表回包不带这两样（只有详情算）
    const list = await request(app).get("/api/branch/videos").expect(200);
    const row = list.body.items.find((v) => String(v._id) === remix);
    expect(row.remixOf).toBeUndefined();
    expect(row.remixCount).toBeUndefined();
  });

  test("R6 remixOf 认不下来不挡发布：脏值 / 不存在的 id / 读不到的私密作品 → 照常 201，只是不落归属", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const priv = await publish(author, { visibility: "private" });

    for (const bad of ["not-an-id", String(new mongoose.Types.ObjectId()), priv]) {
      const id = await publish(fan, { title: "归属认不下来", remixOf: bad });
      const doc = await BranchVideo.findById(id).lean();
      expect(doc.remixOf).toBeUndefined();
      expect((await getVideo(fan, id).expect(200)).body.video.remixOf).toBeUndefined();
    }
  });

  test("R6 原作后来设成私密 / 被删：同款作品的详情里不再带出这条归属，同款作品本身不受影响", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const src = await publish(author);
    const remix = await publish(fan, { remixOf: src });
    expect((await getVideo(fan, remix).expect(200)).body.video.remixOf).toBeTruthy();

    await request(app).patch(`/api/branch/videos/${src}`).set(auth(author)).send({ visibility: "private" }).expect(200);
    expect((await getVideo(fan, remix).expect(200)).body.video.remixOf).toBeUndefined();

    await request(app).delete(`/api/branch/videos/${src}`).set(auth(author)).expect(200);
    const after = (await getVideo(fan, remix).expect(200)).body.video;
    expect(after.remixOf).toBeUndefined();
    expect(after.title).toBe("配方测试作品");
  });

  test("作者 PATCH 作品时塞 recipe / remixOf → 碰不到（提示位只由配方端点写）", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const src = await publish(other);
    const videoId = await publish(author);
    await request(app)
      .patch(`/api/branch/videos/${videoId}`)
      .set(auth(author))
      .send({ title: "改个标题", recipe: { public: true, revision: 0 }, remixOf: src })
      .expect(200);
    const doc = await BranchVideo.findById(videoId).lean();
    expect(doc.title).toBe("改个标题");
    expect(doc.recipe).toBeUndefined();
    expect(doc.remixOf).toBeUndefined();
    expect((await getVideo(null, videoId).expect(200)).body.video.recipePublic).toBeUndefined();
  });
});
