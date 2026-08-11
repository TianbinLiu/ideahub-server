// tests/branchDelete.spec.js
// 覆盖：删自己的评论 / 删自己的弹幕
//   DELETE /api/branch/videos/:id/comments/:commentId
//   DELETE /api/branch/videos/:id/danmaku/:danmakuId
//
// ★ 这套用例盯的是六类【做错了不报错】的问题：
//   X1 只删那一行 → 评论没了，回复还在（一堆没有上文的孤儿）、点赞行还在
//      （挂在 comment 上，评论没了就谁也再查不到、也删不掉）、通知还在
//      （点进去跳到一条不存在的评论，表现是"通知点了没反应"）。四样都不报错。
//   X2 commentCount 不重算 → 评论区显示 3 条，实际只有 1 条。
//   X3 权限判漏 → 谁都能删别人的评论，而且返回 200。
//   X4 只按 commentId 查 → 评论 id 全局唯一，拿私密作品里的评论 id 挂到公开作品的
//      路径上就能删它（与 addComment 核对 parent.video 挡的是同一类旁路）。
//   X5 弹幕的删除端点**泄漏作者** —— 弹幕对外只有一个 mine 布尔，一旦无权删时回
//      "这条属于 xxx"，整面弹幕墙就成了"谁在什么时间看过这个视频"的可查记录。
//   X6 作品作者清理不了自己作品下的内容 —— 这个 App 没有管理员，那就等于没有出口。
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
  const name = `del${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

async function publish(token, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "删除测试作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

const comment = (token, videoId, body) =>
  request(app).post(`/api/branch/videos/${videoId}/comments`).set("Authorization", `Bearer ${token}`).send(body);

const delComment = (token, videoId, commentId) =>
  request(app).delete(`/api/branch/videos/${videoId}/comments/${commentId}`).set("Authorization", `Bearer ${token}`);

const sendDanmaku = (token, videoId, body) =>
  request(app).post(`/api/branch/videos/${videoId}/danmaku`).set("Authorization", `Bearer ${token}`).send(body);

const delDanmaku = (token, videoId, danmakuId) =>
  request(app).delete(`/api/branch/videos/${videoId}/danmaku/${danmakuId}`).set("Authorization", `Bearer ${token}`);

const listComments = (videoId) => request(app).get(`/api/branch/videos/${videoId}/comments`).expect(200);

describe("删评论", () => {
  test("X1 删自己的评论：正文没了、commentCount 回落", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    const c1 = String((await comment(fan.token, id, { text: "第一条" }).expect(201)).body.comment._id);
    await comment(fan.token, id, { text: "第二条" }).expect(201);

    const res = await delComment(fan.token, id, c1).expect(200);
    expect(res.body).toMatchObject({ ok: true, removed: 1, commentCount: 1 });

    const after = await listComments(id);
    expect(after.body.items.map((c) => c.text)).toEqual(["第二条"]);

    // ★ 计数必须跟着回落：不重算的话评论区显示 2 条、实际只有 1 条，而且一个错都不报
    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(detail.body.video.commentCount).toBe(1);
  });

  test("X2 连带删回复 / 评论点赞行 / 指向它的通知", async () => {
    const BranchCommentLike = require("../src/models/BranchCommentLike");
    const Notification = require("../src/models/Notification");

    const author = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    const id = await publish(author.token, { title: "会被清干净的" });

    const top = String((await comment(a.token, id, { text: "顶楼" }).expect(201)).body.comment._id);
    const reply = String(
      (await comment(b.token, id, { text: "回你一句", parentId: top }).expect(201)).body.comment._id
    );
    // 两条都点上赞，产生 BranchCommentLike 行
    await request(app)
      .post(`/api/branch/videos/${id}/comments/${top}/like`)
      .set("Authorization", `Bearer ${b.token}`)
      .expect(200);
    await request(app)
      .post(`/api/branch/videos/${id}/comments/${reply}/like`)
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);

    const ids = [new mongoose.Types.ObjectId(top), new mongoose.Types.ObjectId(reply)];
    expect(await BranchCommentLike.countDocuments({ comment: { $in: ids } })).toBe(2);
    // 顶楼→作品作者的 BRANCH_COMMENT、回复→a 的 BRANCH_COMMENT_REPLY、两条 BRANCH_COMMENT_LIKE
    expect(
      await Notification.countDocuments({
        $or: [{ "payload.commentId": { $in: ids } }, { "payload.parentCommentId": { $in: ids } }],
      })
    ).toBe(4);

    // 删顶楼 → 回复一起走
    const res = await delComment(a.token, id, top).expect(200);
    expect(res.body).toMatchObject({ ok: true, removed: 2, commentCount: 0 });

    const after = await listComments(id);
    expect(after.body.items).toHaveLength(0);
    // ★ 三样残留物一样都不许留下：点赞行谁也再查不到，通知点进去是一条不存在的评论
    expect(await BranchCommentLike.countDocuments({ comment: { $in: ids } })).toBe(0);
    expect(
      await Notification.countDocuments({
        $or: [{ "payload.commentId": { $in: ids } }, { "payload.parentCommentId": { $in: ids } }],
      })
    ).toBe(0);
  });

  test("X3 作品作者能删别人的评论；不相干的人 403", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const stranger = await registerUser();
    const id = await publish(author.token);

    const c = String((await comment(fan.token, id, { text: "刷屏的" }).expect(201)).body.comment._id);

    // 路人删不掉（403 而不是 200 —— 判漏的话谁都能清空别人的评论区）
    await delComment(stranger.token, id, c).expect(403);
    expect((await listComments(id)).body.items).toHaveLength(1);

    // ★ 作品作者能清理自己作品下的内容：这个 App 没有管理员，没有这条路就没有出口
    await delComment(author.token, id, c).expect(200);
    expect((await listComments(id)).body.items).toHaveLength(0);
  });

  test("X4 跨作品 / 私密作品的 commentId 一律 404；非法 id 400；未登录 401", async () => {
    const author = await registerUser();
    const stranger = await registerUser();
    const secret = await publish(author.token, { visibility: "private", title: "私密的" });
    const open = await publish(author.token, { title: "公开的" });
    const ghost = new mongoose.Types.ObjectId().toString();

    const inSecret = String(
      (await comment(author.token, secret, { text: "私密里的" }).expect(201)).body.comment._id
    );

    // ★ 评论 id 全局唯一：不核对归属就等于拿公开作品的路径去删私密作品里的评论
    await delComment(author.token, open, inSecret).expect(404);
    // 私密作品本身对别人就是"不存在"
    await delComment(stranger.token, secret, inSecret).expect(404);
    // 作者自己走对路径当然删得掉
    await delComment(author.token, secret, inSecret).expect(200);

    await delComment(author.token, open, ghost).expect(404);
    await delComment(author.token, open, "not-24-chars").expect(400);
    await request(app).delete(`/api/branch/videos/${open}/comments/${ghost}`).expect(401);
  });

  test("X5 删除路由不会把 /like 那条挡掉（路径形状相近，注册顺序错了就互相吃）", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);
    const c = String((await comment(fan.token, id, { text: "点赞还得能取消" }).expect(201)).body.comment._id);

    await request(app)
      .post(`/api/branch/videos/${id}/comments/${c}/like`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    const un = await request(app)
      .delete(`/api/branch/videos/${id}/comments/${c}/like`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(un.body).toMatchObject({ ok: true, likes: 0, liked: false });
    // 评论本身还在（取消点赞不等于删评论）
    expect((await listComments(id)).body.items).toHaveLength(1);
  });
});

describe("删弹幕", () => {
  test("X6 弹幕作者删自己的；作品作者也能删；删完列表里就没了", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const id = await publish(author.token);

    const mine = String((await sendDanmaku(viewer.token, id, { at: 1, text: "我发的" }).expect(201)).body.danmaku._id);
    const other = String((await sendDanmaku(viewer.token, id, { at: 2, text: "也是我发的" }).expect(201)).body.danmaku._id);

    expect((await delDanmaku(viewer.token, id, mine).expect(200)).body).toEqual({ ok: true });

    // ★ 作品作者要能清理自己作品上飘着的东西
    await delDanmaku(author.token, id, other).expect(200);

    const list = await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  test("X7 无权删时回包/错误文案里**没有一个字**能推出作者是谁", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const stranger = await registerUser();
    const id = await publish(author.token);

    const dm = String((await sendDanmaku(viewer.token, id, { at: 1, text: "匿名的" }).expect(201)).body.danmaku._id);

    const res = await delDanmaku(stranger.token, id, dm).expect(403);
    // ★★ 弹幕对外只有一个 mine 布尔。这里一旦回出作者，对每条弹幕试删一次
    //   就等于把整面弹幕墙变成"谁在什么时间看了这个视频"的可查记录。
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(viewer.userId);
    expect(body).not.toContain(viewer.username);
    expect(body.toLowerCase()).not.toContain("author");

    // 弹幕还在（403 不是"删了但不告诉你"）
    const list = await request(app).get(`/api/branch/videos/${id}/danmaku`).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(["_id", "at", "color", "createdAt", "mine", "text"]);
  });

  test("X8 跨作品 / 私密作品的弹幕 id 一律 404；非法 id 400；未登录 401", async () => {
    const author = await registerUser();
    const stranger = await registerUser();
    const secret = await publish(author.token, { visibility: "private", title: "私密的" });
    const open = await publish(author.token, { title: "公开的" });
    const ghost = new mongoose.Types.ObjectId().toString();

    const inSecret = String(
      (await sendDanmaku(author.token, secret, { at: 1, text: "私密里的" }).expect(201)).body.danmaku._id
    );

    // 弹幕 id 同样是全局唯一的：不连 video 一起查就是绕开可见性的旁路
    await delDanmaku(author.token, open, inSecret).expect(404);
    await delDanmaku(stranger.token, secret, inSecret).expect(404);
    await delDanmaku(author.token, secret, inSecret).expect(200);

    await delDanmaku(author.token, open, ghost).expect(404);
    await delDanmaku(author.token, open, "not-an-id").expect(400);
    await request(app).delete(`/api/branch/videos/${open}/danmaku/${ghost}`).expect(401);
  });
});

describe("删作品时的连带清理", () => {
  test("X9 删作品把弹幕与通知一起带走，不留谁也够不着的孤儿行", async () => {
    // ★ 盯的是一类**只在库里看得见**的泄漏：作品删了之后，挂在它下面的行
    //   既查不到（列表接口先 assertVisible，作品没了直接 404）也删不掉
    //   （删除端点同样要先过作品那一关），于是永远躺在库里。
    //   BranchCommentLike 当初就是这么漏的，弹幕与通知是同一个形状。
    const BranchDanmaku = require("../src/models/BranchDanmaku");
    const Notification = require("../src/models/Notification");

    const author = await registerUser();
    const fan = await registerUser();
    const vid = await publish(author.token, { title: "待删的" });

    await sendDanmaku(fan.token, vid, { at: 1, text: "路过" }).expect(201);
    await comment(fan.token, vid, { text: "写得好" }).expect(201); // → 给作者发一条 BRANCH_COMMENT

    expect(await BranchDanmaku.countDocuments({ video: vid })).toBe(1);
    expect(await Notification.countDocuments({ videoId: vid })).toBe(1);

    await request(app)
      .delete(`/api/branch/videos/${vid}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    expect(await BranchDanmaku.countDocuments({ video: vid })).toBe(0);
    // 通知留着的话，红点亮着、点进去却是"作品不存在"，用户没有任何办法让它消下去
    expect(await Notification.countDocuments({ videoId: vid })).toBe(0);
  });
});
