// tests/branchAdmin.spec.js
// 覆盖：管理员能力的四件事 —— 下架/撤销、删别人的评论与弹幕、平台统计、方舟免单记账。
//
// ★ 这套用例盯的都是【做错了不报错】的那一类：
//   M1 管理端点少了 requireRole → 任何登录用户都能下架别人的作品，接口 200，没人会发现。
//   M2 下架被当成"改 visibility" → 作者一个 PATCH 就能把自己改回来（他本来就有那个按钮）。
//   M3 下架的作品从**作者自己**眼前也消失 → 他只会以为系统吞了作品，然后原样再发一遍。
//   M4 撤销下架写成 `takedown: null` 而不是 $unset → 字段还在，作品永远出不来，零报错。
//   M5 管理员免单**顺手把流水也免了** → 方舟账单上那笔钱在系统里查不到来源，
//      月底对账时分不清是"管理员在调"还是"我们的扣费漏了个口子"，而这两件事的处置相反。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let BranchVideo;
let User;
let TokenLedger;
let wallet;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.ARK_API_KEY; // 方舟那组用例自己按需打开

  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchVideo = require("../src/models/BranchVideo");
  User = require("../src/models/User");
  TokenLedger = require("../src/models/TokenLedger");
  wallet = require("../src/services/tokenWallet.service");
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `adm${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id) };
}

/**
 * 注册一个管理员。
 * ★ 拿到 token **之后**才改 role，而且不重新登录 —— 这正是要钉住的行为：
 *   requireAuth 每次请求都从库里重读 role（不信 JWT 里的快照），所以改完立刻生效。
 *   如果哪天有人把 role 读成 JWT payload 里的那份，下面所有管理端点会一起 403。
 *   （也正因如此，给谁加管理员**不要**去涨 tokenVersion —— 那只会把人踢下线。）
 */
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
      title: extra.title || "待审作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 3 }],
      ...extra,
    });
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const idsOf = (body) => (body.items || []).map((v) => String(v._id));

// ─────────────────────────────────────────────────────────────────────
describe("M1 管理端点的门", () => {
  test("未登录 401、普通用户 403 —— 一条都不许漏", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const id = String((await publish(author.token).expect(201)).body.video._id);

    const endpoints = [
      ["post", `/api/admin/branch/videos/${id}/takedown`],
      ["delete", `/api/admin/branch/videos/${id}/takedown`],
      ["get", "/api/admin/branch/stats"],
      ["get", "/api/admin/branch/takedowns"],
    ];

    for (const [method, path] of endpoints) {
      await request(app)[method](path).send({ reason: "x" }).expect(401);
      await request(app)[method](path).set(bearer(other.token)).send({ reason: "x" }).expect(403);
      // ★ 作品作者本人也不行：下架是**平台**的动作，作者手上那把开关叫 visibility。
      //   少了这一条，"作者改不动下架"就只剩 zod strip 一道，而 strip 是个副作用不是承诺。
      await request(app)[method](path).set(bearer(author.token)).send({ reason: "x" }).expect(403);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("M2/M3 下架：别人看不到，作者看得到且看得到原因", () => {
  test("下架后：匿名/他人的列表、搜索、他人主页、详情、子端点全部没有它", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const admin = await registerAdmin();
    const kw = `td${Date.now().toString(36)}`;
    const id = String((await publish(author.token, { title: `${kw}要被下架的` }).expect(201)).body.video._id);

    // 下架前所有人都看得到（不先证明这一条，下面的"看不到"可能只是因为查询本来就是空的）
    expect(idsOf((await request(app).get("/api/branch/videos").expect(200)).body)).toContain(id);

    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "含违规内容" })
      .expect(200);

    // 首页/分区（同一个列表端点）
    expect(idsOf((await request(app).get("/api/branch/videos").expect(200)).body)).not.toContain(id);
    // 搜索 —— q 占用了顶层 $or，条件没用 $and 拼进去的话这里会漏
    const searched = await request(app).get("/api/branch/videos").query({ q: kw }).expect(200);
    expect(idsOf(searched.body)).not.toContain(id);
    // 他人主页
    const byAuthor = await request(app)
      .get(`/api/branch/videos?author=${author.userId}`)
      .set(bearer(other.token))
      .expect(200);
    expect(idsOf(byAuthor.body)).not.toContain(id);
    // 登录着的别人
    const otherFeed = await request(app).get("/api/branch/videos").set(bearer(other.token)).expect(200);
    expect(idsOf(otherFeed.body)).not.toContain(id);

    // 详情：404 而不是 403（403 等于确认"这个 id 上有东西"）
    await request(app).get(`/api/branch/videos/${id}`).expect(404);
    await request(app).get(`/api/branch/videos/${id}`).set(bearer(other.token)).expect(404);

    // 子端点也要挡：只挡详情不挡子端点就是留了个探测旁路
    await request(app).post(`/api/branch/videos/${id}/play`).expect(404);
    await request(app).post(`/api/branch/videos/${id}/like`).set(bearer(other.token)).expect(404);
    await request(app).get(`/api/branch/videos/${id}/comments`).set(bearer(other.token)).expect(404);
    await request(app)
      .post(`/api/branch/videos/${id}/danmaku`)
      .set(bearer(other.token))
      .send({ text: "还在吗", at: 1 })
      .expect(404);
  });

  test("M3 作者自己仍然看得到，而且看得到原因（凭空消失比下架更糟）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "作者要能看见" }).expect(201)).body.video._id);

    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "涉及第三方版权素材" })
      .expect(200);

    const mine = await request(app).get("/api/branch/videos").set(bearer(author.token)).expect(200);
    expect(idsOf(mine.body)).toContain(id);

    const detail = await request(app).get(`/api/branch/videos/${id}`).set(bearer(author.token)).expect(200);
    expect(detail.body.video.takedown).toBeTruthy();
    expect(detail.body.video.takedown.reason).toBe("涉及第三方版权素材");
    expect(detail.body.video.takedown.at).toBeTruthy();
    // ★ 不许把"是哪个管理员干的"透给作者：审核员不该被摆到被骚扰的位置上
    expect(detail.body.video.takedown.by).toBeUndefined();
    expect(JSON.stringify(detail.body)).not.toContain(admin.userId);
  });

  test("没下架的作品不会凭空多出一个 takedown 键", async () => {
    const author = await registerUser();
    const created = await publish(author.token, { title: "正常作品" }).expect(201);
    expect(created.body.video.takedown).toBeUndefined();
  });

  test("reason 必填（空原因 = 作品消失了还不告诉你为什么）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token).expect(201)).body.video._id);

    await request(app).post(`/api/admin/branch/videos/${id}/takedown`).set(bearer(admin.token)).send({}).expect(400);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "   " })
      .expect(400);
    // 被 400 挡下时不能真的下架了
    await request(app).get(`/api/branch/videos/${id}`).expect(200);
  });

  test("管理员按 id 直取仍然看得到（要审、要清评论），但列表里和别人一样", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "管理员要能复审" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "复审用" })
      .expect(200);

    await request(app).get(`/api/branch/videos/${id}`).set(bearer(admin.token)).expect(200);
    // ★ 列表**不给**特权：管理员刷首页时不该看到全站被下架/私密的东西
    const feed = await request(app).get("/api/branch/videos").set(bearer(admin.token)).expect(200);
    expect(idsOf(feed.body)).not.toContain(id);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("M2 作者改不动下架字段", () => {
  test("PATCH 里塞 takedown 无效（改不掉、也删不掉）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "别想自己解封" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "违规" })
      .expect(200);

    // 带一个合法字段让 patch 非空（否则会被 refine 判成"没有要改的字段"400，
    // 那样测的就不是"takedown 改不动"而是"空 patch 被拒"了）
    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set(bearer(author.token))
      .send({ title: "换个名字", takedown: null })
      .expect(200);

    const detail = await request(app).get(`/api/branch/videos/${id}`).set(bearer(author.token)).expect(200);
    expect(detail.body.video.title).toBe("换个名字"); // 正常字段确实改了，证明这一 PATCH 真的生效过
    expect(detail.body.video.takedown.reason).toBe("违规"); // 下架纹丝不动
    await request(app).get(`/api/branch/videos/${id}`).expect(404); // 对外仍然不可见
  });

  test("把 visibility 改回 public 也没用（两个开关互不顶替）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { visibility: "private" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "违规" })
      .expect(200);

    await request(app)
      .patch(`/api/branch/videos/${id}`)
      .set(bearer(author.token))
      .send({ visibility: "public" })
      .expect(200);

    await request(app).get(`/api/branch/videos/${id}`).expect(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("M4 撤销下架", () => {
  test("撤销后恢复原样，且库里那个字段是真的没了（不是 null）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "误判的作品" }).expect(201)).body.video._id);

    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "误判" })
      .expect(200);
    await request(app).get(`/api/branch/videos/${id}`).expect(404);

    const revoked = await request(app)
      .delete(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .expect(200);
    expect(revoked.body.video.takedown).toBeUndefined();

    await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(idsOf((await request(app).get("/api/branch/videos").expect(200)).body)).toContain(id);

    // ★ 直接看库：必须是 $unset（字段不存在），不是 takedown: null。
    //   写成 null 的话过滤条件仍然放行、看起来能用，但库里会攒下一堆半截记录，
    //   partial 索引也认不出它们。
    const raw = await BranchVideo.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect("takedown" in raw).toBe(false);
  });

  test("对没下架的作品撤销是幂等的（后台重复点不该报错）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token).expect(201)).body.video._id);
    await request(app).delete(`/api/admin/branch/videos/${id}/takedown`).set(bearer(admin.token)).expect(200);
    await request(app).get(`/api/branch/videos/${id}`).expect(200);
  });

  test("下架列表能列出来 —— 否则撤销就是个找不到入口的功能", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "会出现在下架列表里" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "列表用" })
      .expect(200);

    const list = await request(app).get("/api/admin/branch/takedowns").set(bearer(admin.token)).expect(200);
    expect(idsOf(list.body)).toContain(id);
    const row = list.body.items.find((v) => String(v._id) === id);
    // 后台这一路要看得到是谁下的（对作者才藏）
    expect(String(row.takedown.by)).toBe(admin.userId);
    expect(row.takedown.reason).toBe("列表用");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("M1 管理员能删别人的评论 / 弹幕 / 作品", () => {
  test("评论：普通人删别人的 403，管理员 200", async () => {
    const author = await registerUser();
    const commenter = await registerUser();
    const bystander = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "有评论的" }).expect(201)).body.video._id);

    const c = await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set(bearer(commenter.token))
      .send({ text: "一条要被删的评论" })
      .expect(201);
    const commentId = String(c.body.comment._id);

    // 路人删不掉（既不是评论作者也不是作品作者，更不是管理员）
    await request(app)
      .delete(`/api/branch/videos/${id}/comments/${commentId}`)
      .set(bearer(bystander.token))
      .expect(403);

    await request(app)
      .delete(`/api/branch/videos/${id}/comments/${commentId}`)
      .set(bearer(admin.token))
      .expect(200);

    const left = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    expect(idsOf(left.body)).not.toContain(commentId);
  });

  test("弹幕：管理员 200，且回包一个字都不透作者是谁", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const bystander = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "有弹幕的" }).expect(201)).body.video._id);

    const d = await request(app)
      .post(`/api/branch/videos/${id}/danmaku`)
      .set(bearer(viewer.token))
      .send({ text: "刷屏", at: 1.5 })
      .expect(201);
    const danmakuId = String(d.body.danmaku._id);

    const denied = await request(app)
      .delete(`/api/branch/videos/${id}/danmaku/${danmakuId}`)
      .set(bearer(bystander.token))
      .expect(403);
    // ★ 403 的文案里不能出现作者 —— 否则对每条弹幕试删一次就等于逐条查作者
    expect(JSON.stringify(denied.body)).not.toContain(viewer.userId);

    const ok = await request(app)
      .delete(`/api/branch/videos/${id}/danmaku/${danmakuId}`)
      .set(bearer(admin.token))
      .expect(200);
    expect(JSON.stringify(ok.body)).not.toContain(viewer.userId);
  });

  test("作品：管理员能硬删别人的（不可逆那一档）", async () => {
    const author = await registerUser();
    const other = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "要被硬删的" }).expect(201)).body.video._id);

    await request(app).delete(`/api/branch/videos/${id}`).set(bearer(other.token)).expect(403);
    await request(app).delete(`/api/branch/videos/${id}`).set(bearer(admin.token)).expect(200);
    await request(app).get(`/api/branch/videos/${id}`).set(bearer(author.token)).expect(404);
  });

  test("已下架的作品下，管理员照样清得掉评论（不然'下架+清评论'第二步就卡住）", async () => {
    const author = await registerUser();
    const commenter = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "下架后还要清评论" }).expect(201)).body.video._id);
    const c = await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set(bearer(commenter.token))
      .send({ text: "违规评论" })
      .expect(201);

    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "整条清理" })
      .expect(200);

    await request(app)
      .delete(`/api/branch/videos/${id}/comments/${String(c.body.comment._id)}`)
      .set(bearer(admin.token))
      .expect(200);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("平台统计", () => {
  test("四张表的计数按增量对得上，下架数跟着动", async () => {
    // ★ admin 必须先注册（没有它连 stats 都取不到），所以他**不在**增量里；
    //   author 刻意放在快照**之后**注册，这样 users 那一格才真的被测到 ——
    //   两个都放在快照前的话，users 的期望值只能写 0，而写 0 的断言等于没测这一格
    //   （统计端点漏掉 users 字段、或永远回同一个数，都照样绿）。
    const admin = await registerAdmin();

    const before = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats;
    const author = await registerUser();
    for (const k of ["users", "videos", "takenDown", "comments", "danmaku"]) {
      expect(typeof before[k]).toBe("number");
    }

    const id = String((await publish(author.token, { title: "统计用" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set(bearer(author.token))
      .send({ text: "一条评论" })
      .expect(201);
    await request(app)
      .post(`/api/branch/videos/${id}/danmaku`)
      .set(bearer(author.token))
      .send({ text: "一条弹幕", at: 1 })
      .expect(201);
    await request(app)
      .post(`/api/admin/branch/videos/${id}/takedown`)
      .set(bearer(admin.token))
      .send({ reason: "统计用" })
      .expect(200);

    const after = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats;
    expect(after.users - before.users).toBe(1); // 快照之后只注册了 author（admin 在快照之前）
    expect(after.videos - before.videos).toBe(1);
    expect(after.comments - before.comments).toBe(1);
    expect(after.danmaku - before.danmaku).toBe(1);
    expect(after.takenDown - before.takenDown).toBe(1);
  });

  test("待处理举报数：有举报功能就给数字，跟着 pending 走", async () => {
    // ★ 数字与 null 是**两件事**：null = 这台服务端没有举报功能，0 = 没有待处理的举报。
    //   合成一个数就是在骗人 —— 后台要把 null 画成 "—"。
    //   （举报 model 已经落地，所以这里必须是数字；哪天它被拆走，这条会红，
    //     那时改成 `toBeNull()` 而不是改成"允许 0"。）
    const admin = await registerAdmin();
    const reporter = await registerUser();
    const author = await registerUser();
    const Report = require("../src/models/Report");

    const before = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats.pendingReports;
    expect(typeof before).toBe("number");

    const id = String((await publish(author.token, { title: "被举报的" }).expect(201)).body.video._id);
    await Report.create({
      reporter: reporter.userId,
      targetType: "video",
      targetId: id,
      reason: "spam",
      status: "pending",
    });

    const after = (await request(app).get("/api/admin/branch/stats").set(bearer(admin.token)).expect(200))
      .body.stats.pendingReports;
    expect(after - before).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// services/takedown.service —— 举报处理那条线唯一的落点。
//
// ★ 接口形状是 report.controller 的 loadTakedown() 写死的：
//   takedownTarget({targetType, targetId, operatorId, reason, hard}) => Promise，失败 throw。
//   这几条钉的就是那份约定：签名对不上时 report 那边只会回一个 501
//   「下架尚未接入」，而两条线各自都是绿的。
describe("takedownTarget：举报处理的落点", () => {
  const { takedownTarget } = require("../src/services/takedown.service");

  test("video + hard=false → 下架（可撤销，内容还在）", async () => {
    const author = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "举报下架" }).expect(201)).body.video._id);

    const r = await takedownTarget({
      targetType: "video",
      targetId: id,
      operatorId: admin.userId,
      reason: "举报属实",
      hard: false,
    });
    expect(r.applied).toBe("takedown");

    await request(app).get(`/api/branch/videos/${id}`).expect(404); // 别人看不到
    const mine = await request(app).get(`/api/branch/videos/${id}`).set(bearer(author.token)).expect(200);
    expect(mine.body.video.takedown.reason).toBe("举报属实"); // 作者看得到原因
  });

  test("video + hard=true → 连评论/弹幕/通知一起没（复用 purgeVideo，不是另抄一份）", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token, { title: "举报硬删" }).expect(201)).body.video._id);
    await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set(bearer(viewer.token))
      .send({ text: "一条评论" })
      .expect(201);
    await request(app)
      .post(`/api/branch/videos/${id}/danmaku`)
      .set(bearer(viewer.token))
      .send({ text: "一条弹幕", at: 1 })
      .expect(201);

    await takedownTarget({ targetType: "video", targetId: id, operatorId: admin.userId, hard: true });

    await request(app).get(`/api/branch/videos/${id}`).set(bearer(author.token)).expect(404);
    const BranchComment = require("../src/models/BranchComment");
    const BranchDanmaku = require("../src/models/BranchDanmaku");
    expect(await BranchComment.countDocuments({ video: id })).toBe(0);
    expect(await BranchDanmaku.countDocuments({ video: id })).toBe(0);
  });

  test("评论/弹幕的「下架」如实报错，不静默降级成删除", async () => {
    // ★★ 悄悄把"下架"办成"删除"是这一块最坏的失败：举报记录写着 taken_down（可撤销），
    //   内容其实已经没了，事后申诉谁也说不清，而且一个错都不报。
    const author = await registerUser();
    const viewer = await registerUser();
    const admin = await registerAdmin();
    const id = String((await publish(author.token).expect(201)).body.video._id);
    const c = await request(app)
      .post(`/api/branch/videos/${id}/comments`)
      .set(bearer(viewer.token))
      .send({ text: "被举报的评论" })
      .expect(201);
    const commentId = String(c.body.comment._id);

    await expect(
      takedownTarget({ targetType: "comment", targetId: commentId, operatorId: admin.userId, hard: false })
    ).rejects.toMatchObject({ status: 400 });

    // 报错之后内容必须还在（不是"报了错但也删了"）
    const left = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    expect(idsOf(left.body)).toContain(commentId);

    // hard=true 才真的删
    const r = await takedownTarget({
      targetType: "comment",
      targetId: commentId,
      operatorId: admin.userId,
      hard: true,
    });
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const after = await request(app).get(`/api/branch/videos/${id}/comments`).expect(200);
    expect(idsOf(after.body)).not.toContain(commentId);
  });

  test("对象不存在时 throw，绝不静默成功（否则举报会被标成'已处理'而什么都没发生）", async () => {
    const admin = await registerAdmin();
    const ghost = new mongoose.Types.ObjectId().toString();
    await expect(
      takedownTarget({ targetType: "video", targetId: ghost, operatorId: admin.userId, hard: false })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      takedownTarget({ targetType: "video", targetId: ghost, operatorId: admin.userId, hard: true })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      takedownTarget({ targetType: "sticker", targetId: ghost, operatorId: admin.userId })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// M5 方舟免单：不扣钱，但必须留一笔账
//
// ★ 这组要让 callArk 真的走完，所以给一个假的 ARK_API_KEY 并把 fetch 换成间谍。
//   （不这么做的话没配 key 时 callArk 直接回 501，"上游受理了没有"这件事就测不到，
//    而免单的记账时机正是挂在"受理了没有"上的。）
describe("M5 方舟免单：管理员不扣费，但流水照记", () => {
  const { CHAT_TURN_TOKENS, SEEDANCE_2_5, segTokens } = require("../src/config/tokens");
  let fetchSpy;
  let prevKey;

  const chatBody = { model: "doubao-seed-2-1-turbo-260628", messages: [] };

  /** 让上游"受理"（2xx）或"拒了"（非 2xx） */
  function upstream(status, body = { id: "task_x" }) {
    fetchSpy.mockResolvedValue({ status, text: async () => JSON.stringify(body) });
  }

  beforeEach(() => {
    prevKey = process.env.ARK_API_KEY;
    process.env.ARK_API_KEY = "test-key";
    fetchSpy = jest.spyOn(global, "fetch");
    upstream(200);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = prevKey;
  });

  const freeRows = (userId) => TokenLedger.find({ user: userId, reason: "admin_free" }).lean();

  test("管理员调 chat：余额一分不动，但账本上有一笔金额照实的 admin_free", async () => {
    const admin = await registerAdmin();
    const before = await wallet.getWallet(admin.userId);

    await request(app).post("/api/ark/chat/completions").set(bearer(admin.token)).send(chatBody).expect(200);

    const after = await wallet.getWallet(admin.userId);
    expect({ plan: after.plan, addon: after.addon }).toEqual({ plan: before.plan, addon: before.addon });

    const rows = await freeRows(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].delta).toBe(0); // 余额确实没动 —— 账本逐笔累加仍然对得上余额
    expect(rows[0].costTokens).toBe(CHAT_TURN_TOKENS); // 但这笔钱真花出去了，金额照实
    expect(rows[0].balanceAfter).toBe(before.plan + before.addon);
    expect(rows[0].memo).toMatch(/chat/);

    // 顺带钉住：既然没扣费，就一条 ark_spend 都不该有
    expect(await TokenLedger.countDocuments({ user: admin.userId, reason: "ark_spend" })).toBe(0);
  });

  test("同一次调用，普通用户照扣（对照组：免单不是「这条路本来就不收费」）", async () => {
    const user = await registerUser();
    const before = await wallet.getWallet(user.userId);

    await request(app).post("/api/ark/chat/completions").set(bearer(user.token)).send(chatBody).expect(200);

    const after = await wallet.getWallet(user.userId);
    expect(before.plan + before.addon - (after.plan + after.addon)).toBe(CHAT_TURN_TOKENS);
    expect(await TokenLedger.countDocuments({ user: user.userId, reason: "admin_free" })).toBe(0);
  });

  test("上游没受理（400 敏感词）时不记账：账本存在的意义就是与方舟账单对得上", async () => {
    const admin = await registerAdmin();
    upstream(400, { message: "sensitive" });

    await request(app).post("/api/ark/chat/completions").set(bearer(admin.token)).send(chatBody).expect(400);

    expect(await freeRows(admin.userId)).toHaveLength(0);
  });

  test("套餐门禁误伤不到管理员：免费档的管理员也调得动 seedance-2.5", async () => {
    // ★ 那道门守的是"钱"（一段 2.5 超过免费版整月额度）。对一个根本不花钱的人守它，
    //   结果只是管理员自己用不了最贵的那一档，而不是省下任何钱。
    const admin = await registerAdmin();
    const body = { model: SEEDANCE_2_5, duration: 5, content: [] };

    const res = await request(app)
      .post("/api/ark/contents/generations/tasks")
      .set(bearer(admin.token))
      .send(body);
    expect(res.status).toBe(200); // 既不是 403 PLAN_REQUIRED，也不是 402 余额不足

    const rows = await freeRows(admin.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].costTokens).toBe(segTokens(5, SEEDANCE_2_5));
  });

  test("免单不等于免检：未在册的模型对管理员一样 400，且不出网", async () => {
    const admin = await registerAdmin();
    fetchSpy.mockImplementation(async () => {
      throw new Error("不该出网");
    });
    await request(app)
      .post("/api/ark/chat/completions")
      .set(bearer(admin.token))
      .send({ model: "doubao-seedance-9-9-999999", messages: [] })
      .expect(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await freeRows(admin.userId)).toHaveLength(0);
  });

  test("钱包响应头写的是真实余额，不是一个骗人的值", async () => {
    // ★ App 的钱包镜像按这两个头同步。免单时一个头都不写的话，
    //   镜像会停在"本地先减过一次"的值上 —— 界面显示的余额比真实值少，且不报错。
    const admin = await registerAdmin();
    const w = await wallet.getWallet(admin.userId);
    const res = await request(app)
      .post("/api/ark/chat/completions")
      .set(bearer(admin.token))
      .send(chatBody)
      .expect(200);
    expect(res.headers["x-wallet-plan"]).toBe(String(w.plan));
    expect(res.headers["x-wallet-addon"]).toBe(String(w.addon));
  });
});
