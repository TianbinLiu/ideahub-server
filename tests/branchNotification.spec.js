// tests/branchNotification.spec.js
// 覆盖：分支视频的通知（点赞作品 / 评论作品 / 回复评论 / 点赞评论）与它们依赖的
// 楼中楼 + 评论点赞两条新能力。
//
// ★ 这套用例盯的是六类【做错了不报错】的问题：
//   N1 点赞端点是**幂等**的，但通知不能幂等地反复发 —— 重复 POST 一样返回 200，
//      只有去数收件箱才发现作者被同一个人刷了十条"赞了你的作品"。
//   N2 videoId 必须落在**自己的字段**上而不是 ideaId：ideaId 是 ref:"Idea"，
//      装 BranchVideo 的 id 只会 populate 成 null —— 列表照常返回，只是点不进去。
//   N3 parentId 必须活着到库里：z.object 默认 strip 未声明字段，漏声明的表现是
//      "每条回复都静默变成顶层评论"（deck / pricing 已经栽过两次）。
//   N4 回复要通知**被回复那条评论的作者**，不是作品作者。
//   N5 不给自己发通知（自己赞自己、自己回自己）。
//   N6 私密作品与跨作品的父评论必须挡住 —— 否则评论端点成了可见性判断的旁路。
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
/** @param {string} [nameOverride] 需要特定用户名时传（如大小写敏感的用例） */
async function registerUser(nameOverride) {
  seq += 1;
  const name = nameOverride || `nt${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name.toLowerCase()}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

async function publish(token, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "通知测试作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

function comment(token, videoId, body) {
  return request(app)
    .post(`/api/branch/videos/${videoId}/comments`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

/** 收件箱：只看这几类分支通知，别把 ideas 那套的混进来 */
const BRANCH_TYPES =
  "BRANCH_LIKE,BRANCH_COMMENT,BRANCH_COMMENT_REPLY,BRANCH_COMMENT_LIKE,BRANCH_MENTION";

async function inbox(token, type = BRANCH_TYPES) {
  const res = await request(app)
    .get(`/api/notifications?type=${type}&limit=50`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  return res.body.items;
}

describe("分支视频通知", () => {
  test("N1 点赞作品通知作者；重复 POST 不会再发一条", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token, { title: "被赞的作品" });

    const like = () => request(app).post(`/api/branch/videos/${id}/like`).set("Authorization", `Bearer ${fan.token}`);
    await like().expect(200);
    await like().expect(200); // 幂等端点，再点一次仍是 200
    await like().expect(200);

    const items = await inbox(author.token);
    // ★ 三次 POST 只该有一条通知：点赞表的 upsert 只有第一次真插进去
    expect(items.filter((n) => n.type === "BRANCH_LIKE")).toHaveLength(1);
    expect(items[0].payload.videoTitle).toBe("被赞的作品");

    // ★★ 取消再点**也不该**再发一条：DELETE 把 BranchLike 那行删了，下一次 upsertedCount
    //   又是 1 —— 光靠 upsertedCount 判的话，"取消 → 再点"就是一台对着作者收件箱的打桩机
    //   （两次点击的成本）。24 小时窗口内同一个人对同一条作品只提醒一次。
    await request(app).delete(`/api/branch/videos/${id}/like`).set("Authorization", `Bearer ${fan.token}`).expect(200);
    await like().expect(200);
    expect((await inbox(author.token)).filter((n) => n.type === "BRANCH_LIKE")).toHaveLength(1);

    // 但去重是按 {接收者, 触发者, 作品, 类型} 分维度的：换个人赞照样提醒
    const fan2 = await registerUser();
    await request(app).post(`/api/branch/videos/${id}/like`).set("Authorization", `Bearer ${fan2.token}`).expect(200);
    expect((await inbox(author.token)).filter((n) => n.type === "BRANCH_LIKE")).toHaveLength(2);
  });

  test("N1b 评论/回复不去重（每条都是新内容），赞不同评论也各提醒各的", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    // 同一个人在同一条作品下连发两条评论 —— 两条都得提醒，漏一条就是真丢消息
    await comment(fan.token, id, { text: "第一条" }).expect(201);
    await comment(fan.token, id, { text: "第二条" }).expect(201);
    expect((await inbox(author.token)).filter((n) => n.type === "BRANCH_COMMENT")).toHaveLength(2);

    // 赞评论按 commentId 分维度：赞了同一条作品下的两条不同评论，两条都要提醒
    const a = await registerUser();
    const c1 = String((await comment(a.token, id, { text: "A 的第一楼" }).expect(201)).body.comment._id);
    const c2 = String((await comment(a.token, id, { text: "A 的第二楼" }).expect(201)).body.comment._id);
    const likeComment = (cid) =>
      request(app).post(`/api/branch/videos/${id}/comments/${cid}/like`).set("Authorization", `Bearer ${fan.token}`);
    await likeComment(c1).expect(200);
    await likeComment(c2).expect(200);
    expect((await inbox(a.token)).filter((n) => n.type === "BRANCH_COMMENT_LIKE")).toHaveLength(2);

    // 同一条评论取消再赞 → 仍然只有那一条
    await request(app)
      .delete(`/api/branch/videos/${id}/comments/${c1}/like`)
      .set("Authorization", `Bearer ${fan.token}`)
      .expect(200);
    await likeComment(c1).expect(200);
    expect((await inbox(a.token)).filter((n) => n.type === "BRANCH_COMMENT_LIKE")).toHaveLength(2);
  });

  test("N2 videoId 落在自己的字段上并能 populate 出标题（不是塞进 ideaId）", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token, { title: "深链得能点开" });
    await comment(fan.token, id, { text: "好看" }).expect(201);

    const items = await inbox(author.token);
    expect(items).toHaveLength(1);
    const n = items[0];
    // ideaId 是 ref:"Idea"，塞 BranchVideo 的 id 进去 populate 出来永远是 null ——
    // 通知能看、点不进去，而且一个错都不报
    expect(n.ideaId == null).toBe(true);
    expect(n.videoId).toBeTruthy();
    expect(String(n.videoId._id)).toBe(id);
    expect(n.videoId.title).toBe("深链得能点开");
    // 头像/昵称：通知列表每行都要画头像，只 populate username 的话改过名的人会对不上
    expect(n.actorId).toHaveProperty("username");
    expect(Object.keys(n.actorId)).toEqual(expect.arrayContaining(["username"]));
  });

  test("N3 parentId 必须活着到库里：回复不能静默变成顶层评论", async () => {
    const author = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    const id = await publish(author.token);

    const top = await comment(a.token, id, { text: "顶层" }).expect(201);
    const topId = String(top.body.comment._id);
    expect(top.body.comment.parentId).toBeNull();

    const reply = await comment(b.token, id, { text: "回复你", parentId: topId }).expect(201);
    expect(reply.body.comment.parentId).toBe(topId);

    // 读回来也要还在（z.object strip 掉的话这里就是 null）
    const list = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    const got = list.body.items.find((c) => c.text === "回复你");
    expect(got.parentId).toBe(topId);
    // 回复第二层时挂回顶层父，不无限缩进
    const deep = await comment(a.token, id, { text: "回复回复", parentId: String(got._id) }).expect(201);
    expect(deep.body.comment.parentId).toBe(topId);
  });

  test("N4 回复通知的是被回复那条评论的作者，不是作品作者", async () => {
    const author = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    const id = await publish(author.token);

    const top = await comment(a.token, id, { text: "我是 A" }).expect(201);
    await comment(b.token, id, { text: "B 回复 A", parentId: String(top.body.comment._id) }).expect(201);

    const aBox = await inbox(a.token);
    expect(aBox.map((n) => n.type)).toEqual(["BRANCH_COMMENT_REPLY"]);
    expect(aBox[0].payload.commentText).toBe("B 回复 A");
    expect(String(aBox[0].payload.parentCommentId)).toBe(String(top.body.comment._id));

    // 作品作者只该收到 A 那条顶层评论的通知，不该收到这条回复
    const authorBox = await inbox(author.token);
    expect(authorBox.map((n) => n.type)).toEqual(["BRANCH_COMMENT"]);
  });

  test("N5 评论点赞通知评论作者；幂等且不给自己发", async () => {
    const author = await registerUser();
    const a = await registerUser();
    const id = await publish(author.token);
    const top = await comment(a.token, id, { text: "点我" }).expect(201);
    const cid = String(top.body.comment._id);

    const path = `/api/branch/videos/${id}/comments/${cid}/like`;
    const first = await request(app).post(path).set("Authorization", `Bearer ${author.token}`).expect(200);
    expect(first.body).toMatchObject({ ok: true, likes: 1, liked: true });
    await request(app).post(path).set("Authorization", `Bearer ${author.token}`).expect(200);

    const aBox = await inbox(a.token);
    expect(aBox.filter((n) => n.type === "BRANCH_COMMENT_LIKE")).toHaveLength(1);

    // 自己赞自己的评论：不发通知，但计数照涨
    const self = await request(app).post(path).set("Authorization", `Bearer ${a.token}`).expect(200);
    expect(self.body.likes).toBe(2);
    expect((await inbox(a.token)).filter((n) => n.type === "BRANCH_COMMENT_LIKE")).toHaveLength(1);

    // liked 要如实回给点过的人
    const detail = await request(app)
      .get(`/api/branch/videos/${id}`)
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);
    expect(detail.body.video.comments.find((c) => c._id === cid)).toMatchObject({ likes: 2, liked: true });

    // 取消后计数回落、liked 变 false
    await request(app).delete(path).set("Authorization", `Bearer ${a.token}`).expect(200);
    const after = await request(app)
      .get(`/api/branch/videos/${id}/comments`)
      .set("Authorization", `Bearer ${a.token}`)
      .expect(200);
    expect(after.body.items.find((c) => c._id === cid)).toMatchObject({ likes: 1, liked: false });
  });

  test("N6 自己赞自己 / 自己评自己的作品不产生通知", async () => {
    const author = await registerUser();
    const id = await publish(author.token);
    await request(app).post(`/api/branch/videos/${id}/like`).set("Authorization", `Bearer ${author.token}`).expect(200);
    await comment(author.token, id, { text: "自评" }).expect(201);
    expect(await inbox(author.token)).toHaveLength(0);
  });

  test("N7 私密作品与跨作品父评论：评论/点赞端点必须挡住", async () => {
    const author = await registerUser();
    const stranger = await registerUser();
    const secret = await publish(author.token, { visibility: "private", title: "私密的" });
    const open = await publish(author.token, { title: "公开的" });

    // 私密作品：别人评不了、也点不了赞（404 而不是 403）
    await comment(stranger.token, secret, { text: "偷看" }).expect(404);

    const inSecret = await comment(author.token, secret, { text: "作者自己的" }).expect(201);
    const secretCommentId = String(inSecret.body.comment._id);

    // ★ 拿私密作品里的评论 id 挂到公开作品下 —— 不核对归属的话，
    //   这就是给私密评论生出一个可见子节点的旁路
    await comment(stranger.token, open, { text: "跨作品", parentId: secretCommentId }).expect(400);

    // 评论点赞同理：评论 id 全局唯一，只按 id 找就绕开了作品的可见性
    await request(app)
      .post(`/api/branch/videos/${open}/comments/${secretCommentId}/like`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(404);
    await request(app)
      .post(`/api/branch/videos/${secret}/comments/${secretCommentId}/like`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(404);
  });

  test("N9 全部已读带 type 过滤：只标掉这几类，网站那边的通知一条不动", async () => {
    const Notification = require("../src/models/Notification");
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);
    await comment(fan.token, id, { text: "分支那边的" }).expect(201);

    // 官网那条产品线的通知：app 的「消息」页**根本不显示**它
    await Notification.create({ userId: author.userId, actorId: fan.userId, type: "MENTION", payload: {} });

    const unreadOf = async (type) =>
      Notification.countDocuments({ userId: author.userId, readAt: null, ...(type ? { type } : {}) });
    expect(await unreadOf()).toBe(2);

    // app 点「全部已读」→ 只带自己显示的那四类
    const res = await request(app)
      .post("/api/notifications/read-all")
      .set("Authorization", `Bearer ${author.token}`)
      .send({ type: BRANCH_TYPES })
      .expect(200);
    expect(res.body.updated).toBe(1);

    // ★ 用户从没看见过的 MENTION 必须还是未读的：标掉它等于让它永远不再提醒，
    //   而且一点痕迹都没有（两个请求都是 200）
    expect(await unreadOf("MENTION")).toBe(1);
    expect(await unreadOf("BRANCH_COMMENT")).toBe(0);

    // 不带 type 时行为与以前一模一样（官网客户端就是这么调的）
    await request(app)
      .post("/api/notifications/read-all")
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);
    expect(await unreadOf()).toBe(0);
  });

  test("N8 id 不合法 / 不存在：400 与 404 分得清；未登录一律 401", async () => {
    const user = await registerUser();
    const id = await publish(user.token);
    const ghost = new mongoose.Types.ObjectId().toString();

    await comment(user.token, id, { text: "x", parentId: "not-24-chars" }).expect(400); // schema length(24)
    await comment(user.token, id, { text: "x", parentId: ghost }).expect(404); // 合法但不存在
    await request(app)
      .post(`/api/branch/videos/${id}/comments/${ghost}/like`)
      .set("Authorization", `Bearer ${user.token}`)
      .expect(404);
    await request(app).post(`/api/branch/videos/${id}/comments/${ghost}/like`).expect(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// @提及（BRANCH_MENTION）
//
// ★ 这一组盯的同样是【做错了不报错】的问题：
//   M1 解析不到的 @ 必须**明说**没解析到（不在 mentions 里），否则客户端只能乐观加链接，
//      用户点进去 404，而那时评论早发出去了 —— 静默失败（铁律八）。
//   M2 私密作品里的 @ 若照发通知，@ 就成了"探测别人有没有私密作品"的探针：
//      接口一切 200，泄漏在通知里。
//   M3 @ 到作品作者时若两条都发，收件箱里同一件事出现两次、点开是同一个地方。
//   M4 不封顶的话一条评论就能给几百人各发一条推送（发一条评论只受 20/分钟 限流）。
//   M5 旧实现把令牌 toLowerCase() 后做**精确**匹配，凡是带大写字母的用户名一个都 @ 不到，
//      表现是"打了 @ 却没反应"。
//   M6 邮箱地址里的 @ 原来会解析成提及，凭空给陌生人发通知。
// ─────────────────────────────────────────────────────────────────────
describe("分支视频 @提及", () => {
  const mentionsOf = (res) => res.body.comment.mentions;

  test("M1 @ 到的人收到 BRANCH_MENTION；@nobody 谁都不通知、也不进 mentions", async () => {
    const author = await registerUser();
    const bob = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token, { title: "被提及的作品" });

    const res = await comment(fan.token, id, {
      text: `@${bob.username} 快看 @nobody_does_not_exist`,
    }).expect(201);

    // ★ 只回解析成功的那一个：客户端据此只把它渲染成链接，@nobody 保持纯文本
    expect(mentionsOf(res)).toHaveLength(1);
    expect(mentionsOf(res)[0]).toMatchObject({
      token: `@${bob.username}`,
      username: bob.username,
    });
    expect(String(mentionsOf(res)[0].userId)).toBe(bob.userId);
    expect(mentionsOf(res)[0]).toHaveProperty("displayName");

    const bobBox = await inbox(bob.token);
    expect(bobBox.map((n) => n.type)).toEqual(["BRANCH_MENTION"]);
    expect(bobBox[0].payload.videoTitle).toBe("被提及的作品");
    expect(String(bobBox[0].videoId._id)).toBe(id);

    // 作品作者拿到的仍然是 BRANCH_COMMENT —— 提及不该顶替掉结构性通知
    expect((await inbox(author.token)).map((n) => n.type)).toEqual(["BRANCH_COMMENT"]);

    // ★ 明天再读也要还能加链接：mentions 是落库的，且名字是**读的时候**取的
    const list = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    const got = list.body.items.find((c) => c._id === res.body.comment._id);
    expect(got.mentions).toHaveLength(1);
    expect(String(got.mentions[0].userId)).toBe(bob.userId);

    // 改了昵称，读回来的是新昵称（存快照的话这里会是旧值）
    await request(app)
      .put("/api/me/profile")
      .set("Authorization", `Bearer ${bob.token}`)
      .send({ displayName: "改过名的 Bob" })
      .expect(200);
    const detail = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    const inDetail = detail.body.video.comments.find((c) => c._id === res.body.comment._id);
    expect(inDetail.mentions[0].displayName).toBe("改过名的 Bob");
  });

  test("M2 私密作品里 @ 一个看不见它的人：不通知（但正文里照样渲染）", async () => {
    const author = await registerUser();
    const bob = await registerUser();
    const secret = await publish(author.token, { visibility: "private", title: "私密的" });

    const res = await comment(author.token, secret, { text: `@${bob.username} 来看看` }).expect(201);

    // 解析归解析：这条评论本身只有作者看得见，渲染成链接没有任何泄漏
    expect(mentionsOf(res)).toHaveLength(1);
    // ★ 但一条通知都不能发 —— 发了就等于告诉 bob"这里有个你看不见的作品"
    expect(await inbox(bob.token)).toHaveLength(0);

    // 作品转公开后，新的 @ 就该通知得到了（证明上面挡住的是可见性，不是别的什么）
    await request(app)
      .patch(`/api/branch/videos/${secret}`)
      .set("Authorization", `Bearer ${author.token}`)
      .send({ visibility: "public" })
      .expect(200);
    await comment(author.token, secret, { text: `@${bob.username} 现在公开了` }).expect(201);
    expect((await inbox(bob.token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);
  });

  test("M3 @ 到作品作者 / 被回复的人：只发一条，不是两条", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    // 顶层评论里 @ 作品作者 → 只有 BRANCH_COMMENT
    await comment(fan.token, id, { text: `@${author.username} 这段真好` }).expect(201);
    const authorBox = await inbox(author.token);
    expect(authorBox).toHaveLength(1);
    expect(authorBox[0].type).toBe("BRANCH_COMMENT");

    // 回复里 @ 被回复那条评论的作者 → 只有 BRANCH_COMMENT_REPLY
    const a = await registerUser();
    const top = await comment(a.token, id, { text: "我是 A" }).expect(201);
    await comment(fan.token, id, {
      text: `@${a.username} 同意`,
      parentId: String(top.body.comment._id),
    }).expect(201);
    const aBox = await inbox(a.token);
    expect(aBox).toHaveLength(1);
    expect(aBox[0].type).toBe("BRANCH_COMMENT_REPLY");

    // 自己 @ 自己：不给自己发通知
    await comment(a.token, id, { text: `@${a.username} 自言自语` }).expect(201);
    expect(await inbox(a.token)).toHaveLength(1);
  });

  test("M4 每条评论的提及上限（10 个）：多出来的既不入库也不通知", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    const targets = [];
    for (let i = 0; i < 12; i += 1) targets.push(await registerUser());

    const res = await comment(fan.token, id, {
      text: targets.map((t) => `@${t.username}`).join(" "),
    }).expect(201);

    // ★ 按出现顺序取前 10 个，不是随机丢
    expect(mentionsOf(res)).toHaveLength(10);
    expect(mentionsOf(res).map((m) => m.username)).toEqual(targets.slice(0, 10).map((t) => t.username));

    expect((await inbox(targets[0].token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);
    expect((await inbox(targets[9].token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);
    expect(await inbox(targets[10].token)).toHaveLength(0);
    expect(await inbox(targets[11].token)).toHaveLength(0);
  });

  test("M5 大小写不敏感：@JohnDoe 与 @johndoe 都能解析到同一个人", async () => {
    const author = await registerUser();
    const suffix = `${seq}${Date.now().toString(36)}`;
    const john = await registerUser(`JohnDoe_${suffix}`);
    const fan = await registerUser();
    const id = await publish(author.token);

    // 原样键入（含大写）—— 旧实现在这里解析不到任何人，且不报错
    const exact = await comment(fan.token, id, { text: `@${john.username} 你好` }).expect(201);
    expect(mentionsOf(exact)).toHaveLength(1);
    expect(String(mentionsOf(exact)[0].userId)).toBe(john.userId);
    // token 保留键入时的大小写（客户端要拿它在正文里做子串匹配），username 是库里的规范值
    expect(mentionsOf(exact)[0].token).toBe(`@JohnDoe_${suffix}`);
    expect(mentionsOf(exact)[0].username).toBe(`JohnDoe_${suffix}`);

    // 全小写键入 → 同一个人
    const lower = await comment(fan.token, id, {
      text: `@${john.username.toLowerCase()} 再叫一次`,
    }).expect(201);
    expect(String(mentionsOf(lower)[0].userId)).toBe(john.userId);
    expect(mentionsOf(lower)[0].token).toBe(`@johndoe_${suffix}`);

    // ★ 两条评论 = 两条通知：提及**不去重**（每条评论都是新内容，压掉就是丢消息）
    expect((await inbox(john.token)).filter((n) => n.type === "BRANCH_MENTION")).toHaveLength(2);
  });

  test("M8 用户名上限与令牌上限是同一个数：33 字符的名字注册不进来", async () => {
    // ★ 两个数字必须相等，否则中间那一段长度的账号是**合法却永远 @ 不到**的：
    //   令牌只切前 32 个字符，查库对不上任何人，那个 @ 就保持纯文本 —— 打了没反应，
    //   而且两条产品线（官网 ideas 评论、app 分支视频评论）上都一样。
    const { MAX_USERNAME_LEN } = require("../src/utils/username");
    const { MENTION_TOKEN_RE } = require("../src/utils/mentionParser");

    const tooLong = "a".repeat(MAX_USERNAME_LEN + 1);
    await request(app)
      .post("/api/auth/register")
      .send({ username: tooLong, email: `${tooLong}@test.local`, password: "secret123" })
      .expect(400);

    // 正好卡在上限上的名字要能注册，也要能被完整地解析成一个令牌
    const atLimit = `u${Date.now().toString(36)}`.padEnd(MAX_USERNAME_LEN, "x").slice(0, MAX_USERNAME_LEN);
    const user = await registerUser(atLimit);
    expect(user.username).toHaveLength(MAX_USERNAME_LEN);

    MENTION_TOKEN_RE.lastIndex = 0; // 模块级 /g 正则，用前必须复位
    expect(MENTION_TOKEN_RE.exec(`@${atLimit} 你好`)[1]).toBe(atLimit);

    const author = await registerUser();
    const id = await publish(author.token);
    const res = await comment(author.token, id, { text: `@${atLimit} 上限之内` }).expect(201);
    expect(res.body.comment.mentions.map((m) => m.username)).toEqual([atLimit]);
  });

  test("M7 拉黑之后 @ 不进去：赞/评论/回复/提及四条路一起堵住", async () => {
    // ★ 这条盯的是"拉黑对被拉黑方的承诺是假的"：
    //   B 拉黑 A 之后，A 已经私不了信、也不再出现在 B 的搜索结果里 ——
    //   但通知这条路原来一个字都没判：A 在**任意一条公开作品**下打一句 `@B`
    //   就能把消息塞进 B 的收件箱，按评论限流的频率可以一直发。
    //   点赞/评论作者/回复评论是同一个洞（都是往对方收件箱里写一条）。
    const DmRequestBlock = require("../src/models/DmRequestBlock");

    const bob = await registerUser(); // 拉黑的人
    const alice = await registerUser(); // 被拉黑的人
    const outsider = await registerUser();

    // 直接建拉黑关系：这里要测的是通知闸门，不是"能不能拉黑"那套前置规则
    // （utils/blocking 的 assertCanCreateBlock 由 blocking.spec.js 覆盖）
    await DmRequestBlock.create({ blockerUserId: bob.userId, blockedUserId: alice.userId });

    // ① 陌生人的公开作品下 @bob —— 通知一条都不许有
    const open = await publish(outsider.token, { title: "公开的" });
    const res = await comment(alice.token, open, { text: `@${bob.username} 在吗` }).expect(201);
    // 评论本身照发、mentions 照样解析：拦的是通知，不是别人的嘴
    // （连评论一起拒会让 alice 从 403 里反推出"我被 bob 拉黑了"）
    expect(res.body.comment.mentions).toHaveLength(1);
    expect(await inbox(bob.token)).toHaveLength(0);

    // ② bob 自己的作品：alice 评论 / 点赞 —— BRANCH_COMMENT 与 BRANCH_LIKE 也不该进来
    const bobVideo = await publish(bob.token, { title: "bob 的作品" });
    await comment(alice.token, bobVideo, { text: "评论作者" }).expect(201);
    await request(app)
      .post(`/api/branch/videos/${bobVideo}/like`)
      .set("Authorization", `Bearer ${alice.token}`)
      .expect(200);
    expect(await inbox(bob.token)).toHaveLength(0);

    // ③ 回复 bob 的评论 —— BRANCH_COMMENT_REPLY 同理
    const bobTop = await comment(bob.token, open, { text: "bob 的顶楼" }).expect(201);
    await comment(alice.token, open, {
      text: "回你一句",
      parentId: String(bobTop.body.comment._id),
    }).expect(201);
    expect(await inbox(bob.token)).toHaveLength(0);

    // ④ 只挡这一对人：同一条作品下别人 @bob 照常通知得到（证明挡住的是拉黑，不是别的）
    await comment(outsider.token, open, { text: `@${bob.username} 我不是 alice` }).expect(201);
    expect((await inbox(bob.token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);

    // ⑤ 反方向也挡：alice 拉黑 outsider 后，outsider 再 @alice 也进不来
    //   （拉黑是双向失联，不是单向静音 —— 我拉黑的人赞了我，我一样不想收到）
    await DmRequestBlock.create({ blockerUserId: alice.userId, blockedUserId: outsider.userId });
    await comment(outsider.token, open, { text: `@${alice.username} 你好` }).expect(201);
    expect(await inbox(alice.token)).toHaveLength(0);

    // ⑥ 解除拉黑后恢复：证明上面挡住的确实是那条拉黑记录
    await DmRequestBlock.deleteOne({ blockerUserId: bob.userId, blockedUserId: alice.userId });
    await comment(alice.token, open, { text: `@${bob.username} 再试一次` }).expect(201);
    expect((await inbox(bob.token)).filter((n) => n.type === "BRANCH_MENTION")).toHaveLength(2);
  });

  // ── span 这条路（客户端补全面板报范围、服务端核对）────────────────────
  //
  // ★ 这一组盯的是 span 特有的四类【做错了不报错】的问题：
  //   M9  中文昵称根本不可能被正则切出来 —— 没有 span 就是"打了 @ 没反应"；
  //       而 span 存的必须是 userId + 位置，名字现查，否则改名后就对不上。
  //   M10 **不核对**客户端报的名单 = 一个"给任意用户发推送"的接口：正文里一个 @
  //       都没有也能点名一百个人。而且它一切 200，只有去数别人的收件箱才发现得了。
  //   M11 两条路（span / ASCII 自动解析）合并时不去重 → 同一个人收两条通知。
  //   M12 span 不受合并后的上限约束的话，封顶就形同虚设（报 20 个 span 即可绕过）。
  const setDisplayName = (token, displayName) =>
    request(app)
      .put("/api/me/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ displayName })
      .expect(200);

  test("M9 @中文昵称：正则切不出来，靠 span 才成立；改名后已发出的那条跟着显示新名字", async () => {
    const author = await registerUser();
    const wang = await registerUser();
    await setDisplayName(wang.token, "我是王桑");
    const fan = await registerUser();
    const id = await publish(author.token, { title: "中文昵称也要 @ 得到" });

    // ★ 中日韩没有词边界：`@我是王桑你看看这个` 贪婪匹配会把整句吃进去。
    //   补全面板知道用户选了谁，于是把这一段的范围报上来。
    const text = "@我是王桑你看看这个";
    const res = await comment(fan.token, id, {
      text,
      mentions: [{ userId: wang.userId, offset: 0, length: 4 }],
    }).expect(201);

    expect(mentionsOf(res)).toHaveLength(1);
    expect(mentionsOf(res)[0]).toMatchObject({
      token: "@我是王桑",
      displayName: "我是王桑",
      offset: 0,
      length: 4,
    });
    expect(String(mentionsOf(res)[0].userId)).toBe(wang.userId);
    expect((await inbox(wang.token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);

    // ★★ 改名之后，**已经发出去的**那条 @ 读回来必须是新名字 —— 这是产品要的
    //   「改名同步」。它成立的前提正是"落库的是 userId + 位置，名字读的时候现查"。
    await setDisplayName(wang.token, "王桑桑");
    const list = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    const got = list.body.items.find((c) => c._id === res.body.comment._id);
    expect(got.mentions[0].displayName).toBe("王桑桑");
    // 正文一个字都没动（它是当时打出来的字面），渲染端据 span 把这一段换成新名字
    expect(got.text).toBe(text);
    expect(got.mentions[0]).toMatchObject({ offset: 0, length: 4 });
    expect(got.text.slice(0, 1 + 4)).toBe("@我是王桑");
  });

  test("M10 客户端报的名单要**逐条核对**：正文里没写着这个人的名字就丢掉（评论照发）", async () => {
    const author = await registerUser();
    const victim = await registerUser();
    await setDisplayName(victim.token, "受害者");
    const attacker = await registerUser();
    const id = await publish(author.token);
    const ghostId = new mongoose.Types.ObjectId().toString();

    // ① 正文里一个 @ 都没有 —— 不核对的话这就是"点名任意用户"
    const a = await comment(attacker.token, id, {
      text: "什么都没有的一句话",
      mentions: [{ userId: victim.userId, offset: 0, length: 3 }],
    }).expect(201);
    expect(a.body.comment.mentions).toHaveLength(0);

    // ② 有 @，但那一段写的是别人的名字
    const b = await comment(attacker.token, id, {
      text: "@张三 你好",
      mentions: [{ userId: victim.userId, offset: 0, length: 2 }],
    }).expect(201);
    expect(b.body.comment.mentions).toHaveLength(0);

    // ③ 名字对但 offset 没指着那个 `@`（差一位）
    const c = await comment(attacker.token, id, {
      text: "喂 @受害者 在吗",
      mentions: [{ userId: victim.userId, offset: 0, length: 3 }],
    }).expect(201);
    expect(c.body.comment.mentions).toHaveLength(0);

    // ④ 越界（offset+1+length 超出正文）与 ⑤ 幽灵 userId
    const d = await comment(attacker.token, id, {
      text: "@受害者",
      mentions: [
        { userId: victim.userId, offset: 0, length: 999 },
        { userId: ghostId, offset: 0, length: 3 },
      ],
    }).expect(201);
    expect(d.body.comment.mentions).toHaveLength(0);

    // ★ 以上全部 201（一条 @ 没生效不该把用户写好的一段话打回去），
    //   但受害者的收件箱必须一条都没有
    expect(await inbox(victim.token)).toHaveLength(0);

    // ⑥ 形状本身非法 → 这才是 400（zod 挡在 controller 之前）
    await comment(attacker.token, id, {
      text: "@受害者",
      mentions: [{ userId: "not-an-object-id", offset: 0, length: 3 }],
    }).expect(400);
    await comment(attacker.token, id, {
      text: "@受害者",
      mentions: [{ userId: victim.userId, offset: -1, length: 3 }],
    }).expect(400);

    // ⑦ 报对了就照常生效（证明上面挡住的是核对，不是"span 整条路没接上"）
    const ok = await comment(attacker.token, id, {
      text: "@受害者 你好",
      mentions: [{ userId: victim.userId, offset: 0, length: 3 }],
    }).expect(201);
    expect(ok.body.comment.mentions).toHaveLength(1);
    expect((await inbox(victim.token)).map((n) => n.type)).toEqual(["BRANCH_MENTION"]);
  });

  test("M11 两条路合并后去重：同一个人既被 span 报到又被 ASCII 解析到，只算一次", async () => {
    const author = await registerUser();
    const bob = await registerUser(); // 没设昵称 → App 里显示的就是 username
    const fan = await registerUser();
    const id = await publish(author.token);

    const text = `@${bob.username} 你好`;
    const res = await comment(fan.token, id, {
      text,
      // 补全面板选的也是这个人、这一段（昵称为空时报的自然是 username）
      mentions: [{ userId: bob.userId, offset: 0, length: bob.username.length }],
    }).expect(201);

    expect(mentionsOf(res)).toHaveLength(1);
    expect(String(mentionsOf(res)[0].userId)).toBe(bob.userId);
    expect(mentionsOf(res)[0]).toMatchObject({ offset: 0, length: bob.username.length });
    expect((await inbox(bob.token)).filter((n) => n.type === "BRANCH_MENTION")).toHaveLength(1);

    // ★ 老版本 App 压根不发 spans —— 那条路必须还能用（三仓各自独立部署）
    const legacy = await comment(fan.token, id, { text: `@${bob.username} 再叫一次` }).expect(201);
    expect(mentionsOf(legacy)).toHaveLength(1);
    expect(mentionsOf(legacy)[0]).toMatchObject({ offset: 0, length: bob.username.length });
  });

  test("M12 重叠的 span 只留一个；span 也不能绕过合并后的 10 个上限", async () => {
    const author = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    // ① 重叠：`@王桑` 里 A 叫「王桑」、B 叫「王」，两条各自都核得过。
    //   渲染端是**从后往前**替换 span 的，重叠没有正确解 —— 必须只留靠前更长的那个。
    const userA = await registerUser();
    await setDisplayName(userA.token, "王桑");
    const userB = await registerUser();
    await setDisplayName(userB.token, "王");

    const overlap = await comment(fan.token, id, {
      text: "@王桑 在吗",
      mentions: [
        { userId: userB.userId, offset: 0, length: 1 },
        { userId: userA.userId, offset: 0, length: 2 },
      ],
    }).expect(201);
    expect(overlap.body.comment.mentions).toHaveLength(1);
    expect(String(overlap.body.comment.mentions[0].userId)).toBe(userA.userId);
    expect(await inbox(userB.token)).toHaveLength(0);

    // ② 上限作用在**合并之后**：10 个 ASCII 提及已经占满，末尾再报一个 span 也进不来。
    //   （否则"多报几个 span"就是绕过收件箱封顶的口子）
    const targets = [];
    for (let i = 0; i < 10; i += 1) targets.push(await registerUser());
    const extra = await registerUser();
    await setDisplayName(extra.token, "桑桑");

    const prefix = `${targets.map((t) => `@${t.username}`).join(" ")} `;
    const res = await comment(fan.token, id, {
      text: `${prefix}@桑桑`,
      mentions: [{ userId: extra.userId, offset: prefix.length, length: 2 }],
    }).expect(201);

    expect(res.body.comment.mentions).toHaveLength(10);
    expect(res.body.comment.mentions.map((m) => m.username)).toEqual(targets.map((t) => t.username));
    expect(await inbox(extra.token)).toHaveLength(0);
  });

  test("M13 存量提及行没有 offset/length：用 token 反查补出来，不是回一个 undefined", async () => {
    // ★ offset/length 是这次新加的字段，**库里已有的提及行没有它们**。
    //   直接回 undefined 的话，客户端拿不到范围 → 那些老评论里的 @ 全部退回纯文本，
    //   看起来就是"升级了一版，以前的 @ 全没了"，而且一个错都不报。
    //   评论正文是不可编辑的，所以当年存进去的 token 一定还原样躺在 text 里，反查是确定性的。
    const BranchComment = require("../src/models/BranchComment");

    const author = await registerUser();
    const bob = await registerUser();
    await setDisplayName(bob.token, "老数据里的 Bob");
    const id = await publish(author.token);

    // 手写一条"老形状"的评论：只有 {user, token}
    const legacy = await BranchComment.create({
      video: id,
      author: author.userId,
      text: `喂 @${bob.username} 还在吗`,
      mentions: [{ user: bob.userId, token: `@${bob.username}` }],
    });

    const list = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    const got = list.body.items.find((c) => c._id === String(legacy._id));
    expect(got.mentions).toHaveLength(1);
    // 反查出来的范围要真的框住正文里那一段
    expect(got.mentions[0].offset).toBe(2);
    expect(got.mentions[0].length).toBe(bob.username.length);
    expect(got.text.slice(got.mentions[0].offset, got.mentions[0].offset + 1 + got.mentions[0].length)).toBe(
      `@${bob.username}`
    );
    // 名字仍然是现查的（老行里压根没存过名字）
    expect(got.mentions[0].displayName).toBe("老数据里的 Bob");
  });

  test("M6 邮箱地址里的 @ 不算提及", async () => {
    const author = await registerUser();
    const bob = await registerUser();
    const fan = await registerUser();
    const id = await publish(author.token);

    const res = await comment(fan.token, id, {
      text: `有事发邮件 someone@${bob.username} 谢谢`,
    }).expect(201);

    expect(mentionsOf(res)).toHaveLength(0);
    expect(await inbox(bob.token)).toHaveLength(0);
  });
});
