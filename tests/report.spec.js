// tests/report.spec.js
// 覆盖：举报（POST /api/branch/reports、GET|PATCH /api/admin/branch/reports）。
//
// ★ 这套用例盯的是七类【做错了不报错】的问题：
//   R1 唯一索引没建成 —— 预检那次 findOne 在并发下会双双扑空，只有索引真的在
//      才拦得住。没有它，一个人写个循环就能把待处理队列刷成一万条同一个视频。
//   R2 非管理员能读到举报队列 —— 队列里带着举报人、被举报内容正文、以及**弹幕作者**
//      （全系统唯一一处透出它的地方）。漏了这道门就是把匿名弹幕墙去匿名化。
//   R3 处理完不记处理人/处理时间 —— 事后没人说得清是谁下的手，而接口照样 200。
//   R4 下架/删除没真的发生，却把举报标成"已处理" —— 这一整块里最坏的一种失败：
//      管理员以为处理完了、举报者以为被受理了，而内容一直在线，全程零报错（铁律八）。
//      所以 R11/R11b 一律**看内容**（作品 404 了没、评论从列表里没了没），不看状态字段。
//   R5 已处理的举报能被再处理一遍 —— 两个管理员同时点，后写的把先写的盖掉。
//   R6 列表默认不筛 pending —— 处理过一千条之后，待处理的那三条沉在第五十页。
//   R7 举报端点变成"探测私密作品"的旁路 —— 存在就 201、不存在就 404 的话，
//      拿一串 id 挨个试就能数出库里有什么（与 assertVisible 挡的是同一类）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let User;
let Report;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  User = require("../src/models/User");
  Report = require("../src/models/Report");
  // 索引是异步建的：不等它建完，R1 那条会偶发地"重复举报居然成功了"
  await Report.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `rp${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), username: name };
}

/**
 * 提成管理员。
 * ★ 不需要重新登录：requireAuth 每次请求都从库里重读 role（不信 JWT 里的快照），
 *   所以改完立刻生效。也**不要**去涨 tokenVersion —— 那只会把人踢下线。
 */
async function promoteToAdmin(userId) {
  await User.updateOne({ _id: userId }, { $set: { role: "admin" } });
}

async function publish(token, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: extra.title || "举报测试作品",
      category: "剧情",
      segments: [{ title: "第一段", firstFrame: "https://cdn.example.com/a.jpg", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

async function addComment(token, videoId, text) {
  const res = await request(app)
    .post(`/api/branch/videos/${videoId}/comments`)
    .set("Authorization", `Bearer ${token}`)
    .send({ text })
    .expect(201);
  return String(res.body.comment._id);
}

async function addDanmaku(token, videoId, text) {
  const res = await request(app)
    .post(`/api/branch/videos/${videoId}/danmaku`)
    .set("Authorization", `Bearer ${token}`)
    .send({ at: 1.5, text })
    .expect(201);
  return String(res.body.danmaku._id);
}

function report(token, body) {
  return request(app).post("/api/branch/reports").set("Authorization", `Bearer ${token}`).send(body);
}

describe("举报 · 提交", () => {
  test("R1 普通用户能举报，回包带上状态与理由", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author.token);

    const res = await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "spam",
      detail: "整条都是广告",
    }).expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.report).toMatchObject({
      targetType: "video",
      targetId: videoId,
      reason: "spam",
      detail: "整条都是广告",
      status: "pending",
    });
    // 还没人处理，这三样必须是空的（客户端据此显示"待处理"）
    expect(res.body.report.handler).toBeNull();
    expect(res.body.report.handledAt).toBeNull();
    expect(res.body.report.handleNote).toBe("");
  });

  test("R2 同一个人对同一对象只能举报一次：接口 409，且**唯一索引真的在**", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author.token);

    const first = await report(viewer.token, { targetType: "video", targetId: videoId, reason: "porn" }).expect(201);

    const dup = await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "violence", // 换个理由也不行：去重维度是"谁 + 哪个对象"
    }).expect(409);
    expect(dup.body.ok).toBe(false);
    expect(String(dup.body.details.reportId)).toBe(String(first.body.report._id));

    // ★★ 上面那条 409 是 controller 里的**预检**给的 —— 并发下两个请求会双双扑空，
    //   真正兜住的是唯一索引。所以这里绕开接口直接写库，逼索引自己说话：
    //   没有索引的话这次 create 会**成功**，而上面那条用例照样是绿的。
    await expect(
      Report.create({
        reporter: new mongoose.Types.ObjectId(viewer.userId),
        targetType: "video",
        targetId: new mongoose.Types.ObjectId(videoId),
        reason: "other",
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  test("R3 换个对象、换个人都能再举报（去重只在「同一人 × 同一对象」这一格上）", async () => {
    const author = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    const videoId = await publish(author.token);
    const commentId = await addComment(a.token, videoId, "一条评论");

    // 同一个人，不同对象
    await report(a.token, { targetType: "video", targetId: videoId, reason: "spam" }).expect(201);
    await report(a.token, { targetType: "comment", targetId: commentId, reason: "abuse" }).expect(201);
    // 不同人，同一对象
    await report(b.token, { targetType: "video", targetId: videoId, reason: "porn" }).expect(201);

    expect(await Report.countDocuments({ targetId: videoId })).toBe(2);
  });

  test("R4 未登录 401；枚举 / 长度 / id 形状的边界一律 400", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author.token);

    await request(app)
      .post("/api/branch/reports")
      .send({ targetType: "video", targetId: videoId, reason: "spam" })
      .expect(401);

    await report(viewer.token, { targetType: "user", targetId: videoId, reason: "spam" }).expect(400);
    await report(viewer.token, { targetType: "video", targetId: videoId, reason: "我不喜欢" }).expect(400);
    await report(viewer.token, { targetType: "video", targetId: "not-an-id", reason: "spam" }).expect(400);
    await report(viewer.token, { targetType: "video", targetId: videoId }).expect(400); // 缺 reason
    await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "other",
      detail: "字".repeat(501),
    }).expect(400);
  });

  test("R5 举报一个根本不存在的 id 也照样受理 —— 这条端点不能变成存在性探针", async () => {
    const viewer = await registerUser();
    const ghost = new mongoose.Types.ObjectId().toString();

    // ★ 若这里回 404，拿一串 id 挨个试就能把库里有哪些作品数出来（含私密的）。
    //   垃圾举报由唯一索引 + 限流 + 管理端的 target.exists 标记兜住，不靠这里挡。
    await report(viewer.token, { targetType: "video", targetId: ghost, reason: "other" }).expect(201);
  });
});

describe("举报 · 管理端队列", () => {
  test("R6 非管理员看不到队列（403），未登录是 401", async () => {
    const user = await registerUser();

    await request(app).get("/api/admin/branch/reports").expect(401);
    await request(app).get("/api/admin/branch/reports").set("Authorization", `Bearer ${user.token}`).expect(403);
    await request(app)
      .patch(`/api/admin/branch/reports/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", `Bearer ${user.token}`)
      .send({ action: "dismiss" })
      .expect(403);
  });

  test("R7 管理员能列队：默认只给 pending、回显 status、被举报内容被现查出来", async () => {
    const author = await registerUser();
    const reporterA = await registerUser();
    const reporterB = await registerUser();
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    const videoId = await publish(author.token, { title: "会被举报的作品" });
    const danmakuId = await addDanmaku(reporterA.token, videoId, "一条弹幕");

    await report(reporterA.token, { targetType: "video", targetId: videoId, reason: "porn" }).expect(201);
    await report(reporterB.token, { targetType: "video", targetId: videoId, reason: "spam" }).expect(201);
    await report(reporterB.token, { targetType: "danmaku", targetId: danmakuId, reason: "abuse" }).expect(201);

    const res = await request(app)
      .get("/api/admin/branch/reports?limit=50")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    expect(res.body.ok).toBe(true);
    // 生效的筛选条件要回显：老服务端会把这个 query strip 掉然后照常返回全部，
    // 客户端光看内容分不出"筛过"和"压根没筛"
    expect(res.body.status).toBe("pending");
    // ⚠ 这一整个 spec 共用一个库，前面的用例也留了 pending 行 —— 断言绝对总数会
    //   随着后来加用例而莫名其妙地红，所以一律按本用例自己造的 id 过滤
    expect(res.body.items.every((r) => r.status === "pending")).toBe(true);

    const onVideo = res.body.items.filter((r) => String(r.targetId) === videoId);
    expect(onVideo).toHaveLength(2);
    // 同一个对象被几个人举报，是管理员最需要的信号（30 人举报同一条 ≠ 1 人举报 30 条）
    expect(onVideo[0].reportCount).toBe(2);
    expect(onVideo[0].target).toMatchObject({ exists: true, title: "会被举报的作品", visibility: "public" });
    expect(String(onVideo[0].reporter._id)).toBeTruthy();

    // ★ 弹幕这一条会带出作者 —— 全系统唯一一处，成立的前提就是上面 R6 那道 403
    const onDanmaku = res.body.items.find((r) => String(r.targetId) === danmakuId);
    expect(onDanmaku.target).toMatchObject({ exists: true, text: "一条弹幕" });
    expect(String(onDanmaku.target.author._id)).toBe(reporterA.userId);
  });

  test("R8 对象已经没了，也要如实说 exists:false，而不是把这一项省掉", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    const videoId = await publish(author.token, { title: "作者随后自己删了" });
    await report(viewer.token, { targetType: "video", targetId: videoId, reason: "spam" }).expect(201);

    await request(app)
      .delete(`/api/branch/videos/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    const res = await request(app)
      .get(`/api/admin/branch/reports?targetType=video&limit=50`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    const row = res.body.items.find((r) => String(r.targetId) === videoId);
    expect(row.target).toEqual({ exists: false });
  });

  test("R9 status / targetType 拼错要 400，不能静默退回默认值给另一份数据", async () => {
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    await request(app)
      .get("/api/admin/branch/reports?status=pendign")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(400);
    await request(app)
      .get("/api/admin/branch/reports?targetType=user")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(400);
    // all 是合法的（要看全部历史）
    const all = await request(app)
      .get("/api/admin/branch/reports?status=all")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(all.body.status).toBe("all");
  });
});

describe("举报 · 管理端处理", () => {
  test("R10 驳回（dismiss）：状态、处理人、处理时间、备注四样都记下来", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    const videoId = await publish(author.token);
    const created = await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "porn",
    }).expect(201);
    const reportId = String(created.body.report._id);

    const res = await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "dismiss", note: "看过了，没有问题" })
      .expect(200);

    expect(res.body.report.status).toBe("dismissed");
    expect(String(res.body.report.handler._id)).toBe(admin.userId);
    expect(res.body.report.handledAt).toBeTruthy();
    expect(res.body.report.handleNote).toBe("看过了，没有问题");
    expect(res.body.applied).toBe(false);

    // 落库了才算数（回包对、库里没写是另一个"200 但没做事"）
    const inDb = await Report.findById(reportId).lean();
    expect(inDb.status).toBe("dismissed");
    expect(String(inDb.handler)).toBe(admin.userId);

    // 处理完就从待处理队列里消失
    const queue = await request(app)
      .get("/api/admin/branch/reports?limit=50")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);
    expect(queue.body.items.some((r) => String(r._id) === reportId)).toBe(false);

    // ★ 已经处理过的不许再处理一遍：两个管理员同时点，后写的会把先写的悄悄盖掉
    const again = await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "dismiss" })
      .expect(409);
    expect(again.body.details.status).toBe("dismissed");
  });

  test("R11 下架：内容真的对外消失了，同对象其余待处理举报被一并收尾", async () => {
    const author = await registerUser();
    const viewerA = await registerUser();
    const viewerB = await registerUser();
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    const videoId = await publish(author.token, { title: "会被下架的作品" });
    const first = await report(viewerA.token, {
      targetType: "video",
      targetId: videoId,
      reason: "violence",
    }).expect(201);
    const second = await report(viewerB.token, {
      targetType: "video",
      targetId: videoId,
      reason: "porn",
    }).expect(201);

    const res = await request(app)
      .patch(`/api/admin/branch/reports/${first.body.report._id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "takedown", note: "确认违规" })
      .expect(200);

    expect(res.body.report.status).toBe("taken_down");
    // ★ applied 必须来自"真的调到下架服务了"，不是照抄请求里的 action ——
    //   否则服务缺失时那条 501 分支一旦被绕过，回包会理直气壮地说下架成功了
    expect(res.body.applied).toBe(true);
    expect(res.body.takedown).toMatchObject({ applied: "takedown", targetType: "video" });

    // ★★ 光看状态不算数：内容必须真的对外消失（这条断言才是"没有假装处理成功"的证据）
    await request(app).get(`/api/branch/videos/${videoId}`).expect(404);
    // 作者仍然看得见（那条线的规则：从作者眼前抹掉比下架更糟，他只会原样再发一遍）
    await request(app)
      .get(`/api/branch/videos/${videoId}`)
      .set("Authorization", `Bearer ${author.token}`)
      .expect(200);

    // 同一个对象上其余待处理的举报一并收尾：内容已经没了，剩下那些谁也处理不了，
    // 留着就是队列里一批点开只显示"对象已不存在"的死条目
    expect(res.body.alsoResolved).toBe(1);
    const sibling = await Report.findById(second.body.report._id).lean();
    expect(sibling.status).toBe("taken_down");
    expect(String(sibling.handler)).toBe(admin.userId);
  });

  test("R11b 评论/弹幕没有可撤销的下架：takedown 回 400 且举报**原地不动**；delete 才真的删", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);

    const videoId = await publish(author.token);
    const commentId = await addComment(viewer.token, videoId, "一条要被删的评论");
    const created = await report(author.token, {
      targetType: "comment",
      targetId: commentId,
      reason: "abuse",
    }).expect(201);
    const reportId = String(created.body.report._id);

    // ★★ 下架服务对"评论的可撤销下架"是**如实抛错**的，不会偷偷降级成删除。
    //   这里要守的是：它抛错时举报状态**一个字都不许动** —— 否则举报记上 taken_down
    //   （可撤销、内容还在），而内容其实纹丝未动或已经没了，事后谁也说不清。
    await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "takedown" })
      .expect(400);

    const stillPending = await Report.findById(reportId).lean();
    expect(stillPending.status).toBe("pending");
    expect(stillPending.handler).toBeNull();

    // 换成 delete 就真的删掉了
    const res = await request(app)
      .patch(`/api/admin/branch/reports/${reportId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "delete", note: "人身攻击" })
      .expect(200);
    expect(res.body.report.status).toBe("deleted");
    expect(res.body.applied).toBe(true);

    // 评论真的没了（同样：不看状态，看内容）
    const list = await request(app).get(`/api/branch/videos/${videoId}/comments`).expect(200);
    expect(list.body.items.some((c) => String(c._id) === commentId)).toBe(false);
  });

  test("R12 action 只认 takedown / delete / dismiss —— 不许直接指定目标状态", async () => {
    const admin = await registerUser();
    await promoteToAdmin(admin.userId);
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author.token);
    const created = await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "other",
    }).expect(201);

    // 收任意状态的话，客户端就能把一条举报标成"已下架"而没有任何内容被下架
    await request(app)
      .patch(`/api/admin/branch/reports/${created.body.report._id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ status: "taken_down" })
      .expect(400);

    await request(app)
      .patch(`/api/admin/branch/reports/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "dismiss" })
      .expect(404);

    await request(app)
      .patch("/api/admin/branch/reports/not-an-id")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ action: "dismiss" })
      .expect(400);
  });
});

describe("举报 · 儿童安全（csae）插队", () => {
  // ★★ 这一组盯的是一条**对外承诺**：ideahub-client 的 /child-safety 上写着
  //   「这一类举报优先于其他所有举报进入人工复核」。那句话是给 Google Play 审核
  //   与用户看的，兑现它的是 Report.priority + listReports 的 sort ——
  //   而这两处任一被改回去都**零报错**：队列照常返回 200，只是最该先看的那条
  //   静静沉在下面，而页面上仍然写着"优先"。

  test("R15 csae 是合法理由，且哪怕最先提交（最老），也排在待处理队列最前", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token, { title: "插队测试作品" });

    // ① 先提交 csae —— 故意让它成为**最老**的那一条。
    //   队列默认按 createdAt 降序（新的在前），所以不插队的话它必然在后面。
    const early = await registerUser();
    const csae = await report(early.token, {
      targetType: "video",
      targetId: videoId,
      reason: "csae",
      detail: "画面里是未成年人",
    }).expect(201);
    expect(csae.body.report.reason).toBe("csae");

    // ② 再灌一批更新的普通举报（每条换一个人：唯一索引是 reporter+target）
    for (const reason of ["spam", "abuse", "porn"]) {
      const later = await registerUser();
      await report(later.token, { targetType: "video", targetId: videoId, reason }).expect(201);
    }

    const admin = await registerUser();
    await promoteToAdmin(admin.userId);
    const list = await request(app)
      .get("/api/admin/branch/reports?status=pending&limit=50")
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    // 认 id 不认下标之外的任何东西：队列里还有别的用例留下的 pending
    expect(String(list.body.items[0]._id)).toBe(String(csae.body.report._id));
    expect(list.body.items[0].reason).toBe("csae");
  });

  test("R16 priority 由 reason 推导，举报者传什么都不算数", async () => {
    const author = await registerUser();
    const viewer = await registerUser();
    const videoId = await publish(author.token, { title: "插队参数测试" });

    // 能自己填 priority 的话，任何人都能把自己那条顶到队首 —— 队首是最稀缺的资源
    const res = await report(viewer.token, {
      targetType: "video",
      targetId: videoId,
      reason: "spam",
      priority: 99,
    }).expect(201);

    const row = await Report.findById(res.body.report._id).lean();
    expect(row.priority).toBe(0);

    // ② 文档层：**这一半才证伪得了 pre("validate") 钩子**。
    //   只测 ① 的话，controller 本来就不透传 body，把钩子整个删掉这条用例照样绿 ——
    //   一条不会红的断言比没有断言更坏，它给的是虚假的安心（2026-09-03 复核指出）。
    // ★ 换一个 targetId：上面那发已经占了 {reporter,targetType,targetId} 那条唯一索引，
    //   沿用会撞 E11000，测到的就不是钩子而是索引了。
    const forged = new Report({
      reporter: viewer.userId,
      targetType: "video",
      targetId: new mongoose.Types.ObjectId(),
      reason: "spam",
      priority: 99,
    });
    await forged.save();
    expect((await Report.findById(forged._id).lean()).priority).toBe(0);

    // 反过来：csae 不用传任何东西也会被推成 1
    const other = await registerUser();
    const res2 = await report(other.token, {
      targetType: "video",
      targetId: videoId,
      reason: "csae",
    }).expect(201);
    const row2 = await Report.findById(res2.body.report._id).lean();
    expect(row2.priority).toBe(1);
  });

  test("R17 客户端那份理由表是服务端的子集（对不上就是用户选了却发不出去）", () => {
    // ★ 跨仓契约：app 仓 src/api/admin.ts 的 REPORT_REASONS。两仓不在一个 CI 里，
    //   这里只能钉住**服务端这一侧**：csae 必须在枚举里、且必须被标成要插队的那一类。
    expect(Report.REASONS).toContain("csae");
    expect(Report.URGENT_REASONS).toEqual(["csae"]);
    // porn 与 csae 是两个 key，不是父子：合并会让 csae 沉进刷屏举报里
    expect(Report.REASONS).toContain("porn");
    expect(Report.URGENT_REASONS).not.toContain("porn");
  });
});

describe("举报 · 删号级联要放过儿童安全那些", () => {
  // ★★ 对外承诺（ideahubs.org/child-safety）：处置之后**保留举报与处置记录**，
  //   不因内容删除或账号注销一并清掉。而"注销"是产品里人人可点的一颗按钮 ——
  //   不留这个口子的话，被举报的人只要自己走一次删号，指向他的儿童安全举报就全没了。
  //   这是删号权利的**法定义务例外**，不是疏漏。
  test("R18 URGENT_REASONS 是这条豁免的唯一判据，且它确实只放过 csae", () => {
    expect(Report.URGENT_REASONS).toEqual(["csae"]);
    // 普通理由一个都不在豁免名单里 —— 否则删号权利会被悄悄架空
    for (const r of ["porn", "violence", "abuse", "spam", "infringe", "other"]) {
      expect(Report.URGENT_REASONS).not.toContain(r);
    }
  });

  test("R19 删号之后：普通举报被清掉，csae 那条还在", async () => {
    const author = await registerUser();
    const videoId = await publish(author.token, { title: "删号级联测试" });

    const a = await registerUser();
    const b = await registerUser();
    const spam = await report(a.token, { targetType: "video", targetId: videoId, reason: "spam" }).expect(201);
    const csae = await report(b.token, { targetType: "video", targetId: videoId, reason: "csae" }).expect(201);

    const admin = await registerUser();
    await promoteToAdmin(admin.userId);
    await request(app)
      .delete(`/api/admin/branch/users/${author.userId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .expect(200);

    // 判据是**记录还在不在**，不是接口回了什么
    expect(await Report.findById(spam.body.report._id).lean()).toBeNull();
    const kept = await Report.findById(csae.body.report._id).lean();
    expect(kept).not.toBeNull();
    // 留下来的要答得出"报的是什么、谁报的、指向哪一条"
    expect(kept.reason).toBe("csae");
    expect(String(kept.reporter)).toBe(b.userId);
    expect(String(kept.targetId)).toBe(videoId);
  });
});
