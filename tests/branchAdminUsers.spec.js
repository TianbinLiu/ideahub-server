// tests/branchAdminUsers.spec.js
// 覆盖：后台用户管理 —— 列表 / 封禁与解封 / 级联删号 / 发平台通知 / 内容钻取。
//
// ★ 与 branchAdmin.spec.js 同一条纲领：盯的都是【做错了不报错】的那一类 ——
//   U1 新端点少挂 requireRole → 任何登录用户都能封人删号，接口 200，没人会发现。
//   U2 封禁只拦 login 不拦旧 token（或反过来）→ 被封的人揣着没过期的 token 照用一星期。
//   U3 级联漏删一张表 → 库里攒下谁也查不到、也删不掉的行，全程零报错。
//   U4 通知把操作人透出去 → 管理员被摆到被骚扰的位置上。
//   U5 列表把 email 全文回出去 → 任何一个管理员账号被钓走 = 全站联系方式外泄。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;
let BranchVideo;
let BranchComment;
let BranchCommentLike;
let BranchLike;
let BranchDanmaku;
let BranchCard;
let BranchDeck;
let BranchAssetLike;
let BranchAssetStat;
let Report;
let TokenLedger;
let Follow;
let Notification;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.ARK_API_KEY;

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  BranchVideo = require("../src/models/BranchVideo");
  BranchComment = require("../src/models/BranchComment");
  BranchCommentLike = require("../src/models/BranchCommentLike");
  BranchLike = require("../src/models/BranchLike");
  BranchDanmaku = require("../src/models/BranchDanmaku");
  BranchCard = require("../src/models/BranchCard");
  BranchDeck = require("../src/models/BranchDeck");
  BranchAssetLike = require("../src/models/BranchAssetLike");
  BranchAssetStat = require("../src/models/BranchAssetStat");
  Report = require("../src/models/Report");
  TokenLedger = require("../src/models/TokenLedger");
  Follow = require("../src/models/Follow");
  Notification = require("../src/models/Notification");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `au${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name, password: "secret123" };
}

/** 拿到 token 之后才改 role（requireAuth 每次请求重读库，改完立刻生效）*/
async function registerAdmin() {
  const u = await registerUser();
  await User.updateOne({ _id: u.userId }, { $set: { role: "admin" } });
  return u;
}

function publish(token, extra = {}) {
  return request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "后台用例作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 3 }],
      ...extra,
    });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const login = (u) =>
  request(app).post("/api/auth/login").send({ emailOrUsername: u.username, password: u.password });

// ─────────────────────────────────────────────────────────────────────
describe("U1 新端点的门", () => {
  test("未登录 401、普通用户 403 —— 一条都不许漏", async () => {
    const other = await registerUser();
    const victim = await registerUser();

    const endpoints = [
      ["get", "/api/admin/branch/users"],
      ["post", `/api/admin/branch/users/${victim.userId}/ban`],
      ["delete", `/api/admin/branch/users/${victim.userId}/ban`],
      ["delete", `/api/admin/branch/users/${victim.userId}`],
      ["post", `/api/admin/branch/users/${victim.userId}/notify`],
      ["get", "/api/admin/branch/videos"],
      ["get", "/api/admin/branch/comments"],
      ["get", "/api/admin/branch/danmaku"],
    ];

    for (const [method, path] of endpoints) {
      await request(app)[method](path).send({ reason: "x", text: "x" }).expect(401);
      await request(app)[method](path).set(bearer(other.token)).send({ reason: "x", text: "x" }).expect(403);
    }
    // 403 之后 victim 必须毫发无损（门要是只拦了状态码没拦动作，这里会现形）
    expect(await User.countDocuments({ _id: victim.userId })).toBe(1);
    const fresh = await User.findById(victim.userId).select("banned").lean();
    expect(fresh.banned).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("U2 封禁：login 与带 token 的请求各拦一道，解封恢复", () => {
  test("封禁后 login 403（原因可读），旧 token 也 403 BANNED；解封后两条路都恢复", async () => {
    const victim = await registerUser();
    const admin = await registerAdmin();

    // 封禁前两条路都通（先证明"通"，后面的"不通"才有意义）
    await login(victim).expect(200);
    await request(app).get("/api/notifications").set(bearer(victim.token)).expect(200);

    await request(app)
      .post(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .send({ reason: "多次发布违规内容" })
      .expect(200);

    // login：403 + 原因原样可读（用户第一反应是"为什么"）
    const denied = await login(victim).expect(403);
    expect(denied.body.code).toBe("BANNED");
    expect(denied.body.message).toContain("多次发布违规内容");
    // ★ 不许把"是哪个管理员封的"透给用户（与 takedown.by 同一条理由）
    expect(JSON.stringify(denied.body)).not.toContain(admin.userId);

    // 旧 token：一样 403 BANNED（不拦这条的话，没过期的 token 还能用一星期）
    const reqDenied = await request(app).get("/api/notifications").set(bearer(victim.token)).expect(403);
    expect(reqDenied.body.code).toBe("BANNED");
    expect(reqDenied.body.message).toContain("多次发布违规内容");

    // 解封：$unset 干净（不是 null），两条路立刻恢复
    await request(app)
      .delete(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .expect(200);
    const raw = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(victim.userId) });
    expect("banned" in raw).toBe(false);
    await login(victim).expect(200);
    await request(app).get("/api/notifications").set(bearer(victim.token)).expect(200);
  });

  test("reason 必填；被 400 挡下时不能真的封了", async () => {
    const victim = await registerUser();
    const admin = await registerAdmin();

    await request(app)
      .post(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .send({})
      .expect(400);
    await request(app)
      .post(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .send({ reason: "   " })
      .expect(400);

    await login(victim).expect(200); // 还登得进去 = 没被误封
  });

  test("拒绝封禁管理员（403）—— 两个管理员互相点一下就能把后台锁死", async () => {
    const adminA = await registerAdmin();
    const adminB = await registerAdmin();

    await request(app)
      .post(`/api/admin/branch/users/${adminB.userId}/ban`)
      .set(bearer(adminA.token))
      .send({ reason: "手滑" })
      .expect(403);

    // B 毫发无损，照常用后台
    await request(app).get("/api/admin/branch/stats").set(bearer(adminB.token)).expect(200);
  });

  test("解封是幂等的（对没封的人解封 200，后台重复点不该报错）", async () => {
    const victim = await registerUser();
    const admin = await registerAdmin();
    await request(app)
      .delete(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .expect(200);
    await login(victim).expect(200);
  });

  test("封人不藏内容（两权分开）：被封作者的作品照常在首页", async () => {
    const victim = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(victim.token, { title: "封人不该藏我" }).expect(201)).body.video._id);

    await request(app)
      .post(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .send({ reason: "刷屏" })
      .expect(200);

    const feed = await request(app).get("/api/branch/videos").expect(200);
    expect((feed.body.items || []).map((v) => String(v._id))).toContain(id);
  });

  test("stats.banned 跟着封禁数走", async () => {
    const admin = await registerAdmin();
    const before = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats;
    expect(typeof before.banned).toBe("number");

    const victim = await registerUser();
    await request(app)
      .post(`/api/admin/branch/users/${victim.userId}/ban`)
      .set(bearer(admin.token))
      .send({ reason: "统计用" })
      .expect(200);

    const after = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats;
    expect(after.banned - before.banned).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("U3 删除账号：拒删管理员 + 级联真的删干净", () => {
  test("拒绝删除管理员（403，防手滑团灭）", async () => {
    const adminA = await registerAdmin();
    const adminB = await registerAdmin();

    await request(app).delete(`/api/admin/branch/users/${adminB.userId}`).set(bearer(adminA.token)).expect(403);
    expect(await User.countDocuments({ _id: adminB.userId })).toBe(1);
  });

  test("级联：作品/评论/弹幕/点赞/卡片卡组/举报/流水/关注/通知，逐 collection 断言清零", async () => {
    const victim = await registerUser();
    const other = await registerUser();
    const admin = await registerAdmin();

    // ── 铺数据 ──
    // victim 的作品 V1，other 在上面留下评论 / 点赞 / 弹幕 / 举报
    const v1 = String((await publish(victim.token, { title: "要被级联的作品" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/branch/videos/${v1}/comments`)
      .set(bearer(other.token))
      .send({ text: "别人的评论" })
      .expect(201);
    await request(app).post(`/api/branch/videos/${v1}/like`).set(bearer(other.token)).expect(200);
    await request(app)
      .post(`/api/branch/videos/${v1}/danmaku`)
      .set(bearer(other.token))
      .send({ text: "别人的弹幕", at: 1 })
      .expect(201);
    await request(app)
      .post("/api/branch/reports")
      .set(bearer(other.token))
      .send({ targetType: "video", targetId: v1, reason: "spam" })
      .expect(201);

    // other 的作品 V2，victim 在上面：顶层评论（other 再回复它）、点赞、弹幕、点赞 other 的评论
    const v2 = String((await publish(other.token, { title: "别人的作品要活下来" }).expect(201)).body.video._id);
    const vc = await request(app)
      .post(`/api/branch/videos/${v2}/comments`)
      .set(bearer(victim.token))
      .send({ text: "victim 的评论" })
      .expect(201);
    const victimCommentId = String(vc.body.comment._id);
    await request(app)
      .post(`/api/branch/videos/${v2}/comments`)
      .set(bearer(other.token))
      .send({ text: "回复 victim 的", parentId: victimCommentId })
      .expect(201);
    const oc = await request(app)
      .post(`/api/branch/videos/${v2}/comments`)
      .set(bearer(other.token))
      .send({ text: "other 自己的评论，要活下来" })
      .expect(201);
    const otherCommentId = String(oc.body.comment._id);
    await request(app).post(`/api/branch/videos/${v2}/like`).set(bearer(victim.token)).expect(200);
    await request(app)
      .post(`/api/branch/videos/${v2}/comments/${otherCommentId}/like`)
      .set(bearer(victim.token))
      .expect(200);
    await request(app)
      .post(`/api/branch/videos/${v2}/danmaku`)
      .set(bearer(victim.token))
      .send({ text: "victim 的弹幕", at: 2 })
      .expect(201);
    await request(app)
      .post("/api/branch/reports")
      .set(bearer(victim.token))
      .send({ targetType: "video", targetId: v2, reason: "other" })
      .expect(201);

    // 卡片 / 卡组 / 流水 / 关注（直接落库铺，接口不是这条用例要测的东西）
    await BranchCard.create({ owner: victim.userId, cardId: "card_x1", name: "卡" });
    const deck = await BranchDeck.create({ owner: victim.userId, name: "组", cardIds: ["card_x1"] });
    await BranchAssetStat.create({ kind: "deck", key: String(deck._id), views: 3, likes: 1 });
    await BranchAssetLike.create({ user: other.userId, kind: "deck", key: String(deck._id), action: "like" });
    await TokenLedger.create({
      user: victim.userId,
      delta: 100,
      reason: "grant",
      costTokens: 0,
      balanceAfter: 100,
    });
    await Follow.create({ follower: victim.userId, following: other.userId });
    await Follow.create({ follower: other.userId, following: victim.userId });

    // V2 删前的基线：3 条评论（victim 的 + other 的回复 + other 自己的）
    const v2Before = await request(app).get(`/api/branch/videos/${v2}`).expect(200);
    expect(v2Before.body.video.commentCount).toBe(3);
    expect(v2Before.body.video.likes).toBe(1);

    // ── 删 ──
    const res = await request(app)
      .delete(`/api/admin/branch/users/${victim.userId}`)
      .set(bearer(admin.token))
      .expect(200);
    // 回包要说清删了哪些、各多少条（"删了个寂寞"必须有症状）
    expect(res.body.removed.videos).toBe(1);
    expect(res.body.removed.user).toBe(1);
    expect(res.body.removed.cards).toBe(1);
    expect(res.body.removed.decks).toBe(1);

    // ── 逐 collection 断言 ──
    const uid = new mongoose.Types.ObjectId(victim.userId);
    expect(await User.countDocuments({ _id: uid })).toBe(0);
    expect(await BranchVideo.countDocuments({ author: uid })).toBe(0);
    // V1 整棵没了：别人留在上面的评论/点赞/弹幕一并清掉（purgeVideo 的清单）
    expect(await BranchComment.countDocuments({ video: v1 })).toBe(0);
    expect(await BranchLike.countDocuments({ video: v1 })).toBe(0);
    expect(await BranchDanmaku.countDocuments({ video: v1 })).toBe(0);
    // victim 发在别人作品下的评论没了，**other 回复它的那条也没了**（孤儿楼中楼）
    expect(await BranchComment.countDocuments({ author: uid })).toBe(0);
    expect(await BranchComment.countDocuments({ parent: victimCommentId })).toBe(0);
    expect(await BranchDanmaku.countDocuments({ author: uid })).toBe(0);
    expect(await BranchLike.countDocuments({ user: uid })).toBe(0);
    expect(await BranchCommentLike.countDocuments({ user: uid })).toBe(0);
    expect(await BranchCard.countDocuments({ owner: uid })).toBe(0);
    expect(await BranchDeck.countDocuments({ owner: uid })).toBe(0);
    // 他卡组的计数行与别人对它点的赞也没了（卡组没了这些行谁也查不到）
    expect(await BranchAssetStat.countDocuments({ kind: "deck", key: String(deck._id) })).toBe(0);
    expect(await BranchAssetLike.countDocuments({ kind: "deck", key: String(deck._id) })).toBe(0);
    // 举报：他提的 + 指向他内容的，都没了
    expect(await Report.countDocuments({ reporter: uid })).toBe(0);
    expect(await Report.countDocuments({ targetType: "video", targetId: v1 })).toBe(0);
    expect(await TokenLedger.countDocuments({ user: uid })).toBe(0);
    expect(await Follow.countDocuments({ $or: [{ follower: uid }, { following: uid }] })).toBe(0);
    expect(await Notification.countDocuments({ $or: [{ userId: uid }, { actorId: uid }] })).toBe(0);

    // ── 别人的东西要活下来，而且计数是重算过的 ──
    const v2After = await request(app).get(`/api/branch/videos/${v2}`).expect(200);
    expect(v2After.body.video.commentCount).toBe(1); // 只剩 other 自己的那条
    expect(v2After.body.video.likes).toBe(0); // victim 的赞撤走并重算了快照
    const ocAfter = await BranchComment.findById(otherCommentId).lean();
    expect(ocAfter).toBeTruthy();
    expect(ocAfter.likes).toBe(0); // victim 给这条评论的赞同样撤走重算
    await login(other).expect(200);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("U4 发平台通知（ADMIN_NOTICE）", () => {
  test("通知真的落库、收件人读得到，且不透操作人", async () => {
    const target = await registerUser();
    const admin = await registerAdmin();

    await request(app)
      .post(`/api/admin/branch/users/${target.userId}/notify`)
      .set(bearer(admin.token))
      .send({ text: "你的作品《测试》已按社区规范处理，如有疑问请联系客服。" })
      .expect(201);

    const row = await Notification.findOne({ userId: target.userId, type: "ADMIN_NOTICE" }).lean();
    expect(row).toBeTruthy();
    expect(row.payload.text).toContain("社区规范");
    // ★ 平台口径发出：不带 actorId（谁发的只进操作日志）
    expect(row.actorId ?? null).toBeNull();

    // 收件人从通知列表读得到，且整包回包里嗅不到管理员的 id
    const inbox = await request(app).get("/api/notifications").set(bearer(target.token)).expect(200);
    const mine = (inbox.body.items || []).find((n) => n.type === "ADMIN_NOTICE");
    expect(mine).toBeTruthy();
    expect(mine.payload.text).toContain("社区规范");
    expect(JSON.stringify(inbox.body)).not.toContain(admin.userId);
  });

  test("text 必填、1~500 字", async () => {
    const target = await registerUser();
    const admin = await registerAdmin();

    await request(app)
      .post(`/api/admin/branch/users/${target.userId}/notify`)
      .set(bearer(admin.token))
      .send({})
      .expect(400);
    await request(app)
      .post(`/api/admin/branch/users/${target.userId}/notify`)
      .set(bearer(admin.token))
      .send({ text: "   " })
      .expect(400);
    await request(app)
      .post(`/api/admin/branch/users/${target.userId}/notify`)
      .set(bearer(admin.token))
      .send({ text: "长".repeat(501) })
      .expect(400);
    expect(await Notification.countDocuments({ userId: target.userId, type: "ADMIN_NOTICE" })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("U5 用户列表", () => {
  test("搜索命中 displayName；email 打码不外泄", async () => {
    const admin = await registerAdmin();
    const u = await registerUser();
    const tag = `王小明${Date.now().toString(36)}`;
    await User.updateOne({ _id: u.userId }, { $set: { displayName: tag } });

    const res = await request(app)
      .get("/api/admin/branch/users")
      .query({ q: tag.slice(0, 6) }) // 子串就要命中，不要求全名
      .set(bearer(admin.token))
      .expect(200);
    const hit = res.body.items.find((x) => String(x._id) === u.userId);
    expect(hit).toBeTruthy();
    expect(hit.displayName).toBe(tag);
    // email 全文不许出现在回包任何角落；打码版要还认得出个大概
    expect(JSON.stringify(res.body)).not.toContain(`${u.username}@test.local`);
    expect(hit.email).toBe(`${u.username[0]}***@test.local`);
  });

  test("封禁状态筛选 + banned 键的有无语义", async () => {
    const admin = await registerAdmin();
    const banned = await registerUser();
    const normal = await registerUser();
    await request(app)
      .post(`/api/admin/branch/users/${banned.userId}/ban`)
      .set(bearer(admin.token))
      .send({ reason: "筛选用" })
      .expect(200);

    const only = await request(app)
      .get("/api/admin/branch/users")
      .query({ banned: "1" })
      .set(bearer(admin.token))
      .expect(200);
    const ids = only.body.items.map((x) => String(x._id));
    expect(ids).toContain(banned.userId);
    expect(ids).not.toContain(normal.userId);
    const row = only.body.items.find((x) => String(x._id) === banned.userId);
    expect(row.banned.reason).toBe("筛选用");
    expect(row.banned.at).toBeTruthy();

    const none = await request(app)
      .get("/api/admin/branch/users")
      .query({ banned: "0" })
      .set(bearer(admin.token))
      .expect(200);
    const cleanRow = none.body.items.find((x) => String(x._id) === normal.userId);
    expect(cleanRow).toBeTruthy();
    expect(cleanRow.banned).toBeUndefined(); // 没封 = 没有这个键（不是 null）

    // 筛选值拼错要 400，不许静默当成"不筛"（悄悄给另一份数据比报错难查）
    await request(app)
      .get("/api/admin/branch/users")
      .query({ banned: "yes" })
      .set(bearer(admin.token))
      .expect(400);
  });

  test("role 筛选 + 作品/评论计数 + 分页边界", async () => {
    const admin = await registerAdmin();
    const author = await registerUser();
    const vid = String((await publish(author.token, { title: "计数用" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/branch/videos/${vid}/comments`)
      .set(bearer(author.token))
      .send({ text: "自评" })
      .expect(201);

    const admins = await request(app)
      .get("/api/admin/branch/users")
      .query({ role: "admin" })
      .set(bearer(admin.token))
      .expect(200);
    expect(admins.body.items.every((x) => x.role === "admin")).toBe(true);
    expect(admins.body.items.map((x) => String(x._id))).toContain(admin.userId);

    const page1 = await request(app)
      .get("/api/admin/branch/users")
      .query({ limit: 2, page: 1 })
      .set(bearer(admin.token))
      .expect(200);
    expect(page1.body.items.length).toBe(2);
    expect(page1.body.total).toBeGreaterThanOrEqual(2);

    // 越过末页：空列表 + total 不变（不是报错，也不是把第一页再给一遍）
    const far = await request(app)
      .get("/api/admin/branch/users")
      .query({ limit: 50, page: 999 })
      .set(bearer(admin.token))
      .expect(200);
    expect(far.body.items).toEqual([]);
    expect(far.body.total).toBe(page1.body.total);

    // 计数是真的（countDocuments/聚合，不是写死的 0）
    const all = await request(app)
      .get("/api/admin/branch/users")
      .query({ q: author.username })
      .set(bearer(admin.token))
      .expect(200);
    const row = all.body.items.find((x) => String(x._id) === author.userId);
    expect(row.videoCount).toBe(1);
    expect(row.commentCount).toBe(1);

    // role 拼错 400
    await request(app)
      .get("/api/admin/branch/users")
      .query({ role: "superadmin" })
      .set(bearer(admin.token))
      .expect(400);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("U6 内容钻取", () => {
  test("作品列表：私密/已下架都列得出来，能按下架筛、按作者名搜", async () => {
    const admin = await registerAdmin();
    const author = await registerUser();
    const pub = String((await publish(author.token, { title: "钻取公开" }).expect(201)).body.video._id);
    const priv = String(
      (await publish(author.token, { title: "钻取私密", visibility: "private" }).expect(201)).body.video._id
    );
    await request(app)
      .post(`/api/admin/branch/videos/${pub}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "钻取用" })
      .expect(200);

    // 不筛：私密与已下架都在（后台要看得全，与公开列表的 readableFilter 相反）
    const all = await request(app)
      .get("/api/admin/branch/videos")
      .query({ q: author.username })
      .set(bearer(admin.token))
      .expect(200);
    const ids = all.body.items.map((v) => String(v._id));
    expect(ids).toContain(pub);
    expect(ids).toContain(priv);
    // admin 视角带 takedown.by（对作者才藏）
    const down = all.body.items.find((v) => String(v._id) === pub);
    expect(down.takedown.reason).toBe("钻取用");
    expect(String(down.takedown.by)).toBe(admin.userId);

    const onlyDown = await request(app)
      .get("/api/admin/branch/videos")
      .query({ takenDown: "1", q: author.username })
      .set(bearer(admin.token))
      .expect(200);
    const downIds = onlyDown.body.items.map((v) => String(v._id));
    expect(downIds).toContain(pub);
    expect(downIds).not.toContain(priv);
  });

  test("评论/弹幕列表：按正文搜、按作品筛；弹幕在这里（仅这里）带作者", async () => {
    const admin = await registerAdmin();
    const author = await registerUser();
    const viewer = await registerUser();
    const vid = String((await publish(author.token, { title: "钻取评论弹幕" }).expect(201)).body.video._id);
    const kw = `dz${Date.now().toString(36)}`;
    await request(app)
      .post(`/api/branch/videos/${vid}/comments`)
      .set(bearer(viewer.token))
      .send({ text: `含关键词${kw}的评论` })
      .expect(201);
    await request(app)
      .post(`/api/branch/videos/${vid}/danmaku`)
      .set(bearer(viewer.token))
      .send({ text: `弹${kw}`, at: 3 })
      .expect(201);

    const comments = await request(app)
      .get("/api/admin/branch/comments")
      .query({ q: kw })
      .set(bearer(admin.token))
      .expect(200);
    expect(comments.body.items.length).toBe(1);
    expect(comments.body.items[0].text).toContain(kw);
    expect(String(comments.body.items[0].video._id)).toBe(vid);

    const byVideo = await request(app)
      .get("/api/admin/branch/danmaku")
      .query({ videoId: vid })
      .set(bearer(admin.token))
      .expect(200);
    expect(byVideo.body.items.length).toBe(1);
    // ★ 弹幕作者只在 admin 门后可见（对普通用户永远只有 mine 布尔）
    expect(String(byVideo.body.items[0].author._id)).toBe(viewer.userId);

    // videoId 拼错 400，不静默空表
    await request(app)
      .get("/api/admin/branch/danmaku")
      .query({ videoId: "not-an-id" })
      .set(bearer(admin.token))
      .expect(400);
  });
});
