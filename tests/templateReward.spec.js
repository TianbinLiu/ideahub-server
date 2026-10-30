// tests/templateReward.spec.js
// 覆盖：模板作者奖励（2026-10-30）—— 别人套用了你的模板出片、公开发布满 24 小时还公开着，平台印一笔 token 给模板作者。
// 实现：services/templateReward.service.js（判定与发放）、config/templateReward.js（几个数与开关）、models/TemplateReward.js（判定记录）、
// branchVideo.controller 的 resolveTemplateIds（发布 / 回炉体里的 templateIds 怎么落）。照 tests/remixReward.spec.js 复制，盯的是同一类
// 【做错了不报错】的问题：
//   W1 钱的去向：只有模板作者的 addon 多 10k；套模板的人的钱包一个 token 都不动；这笔入账不抵欠额、不冲当日用量。
//   W2 恰好一次：清扫器重跑不重发；回炉重报同一个模板不再判；崩在占位之后的两种残局各自续办成一次。
//   W3 规则：不满 24 小时不判；到期不公开的、模板没了的、被封的、自己套自己的、两人之间有拉黑的都不发，而且就此定案。
//   W4 三道上限 + 保险丝：每个模板 200 次、每位模板作者 24 小时内 20 次、每个使用者 24 小时内 3 次；全站保险丝；到了的不顺延。
//   W5 发布体：老发布体不带 templateIds 什么都不落；不存在的 id 丢掉、去重、上限 20；回包不泄露 pending；删号只删「他是模板作者」的行。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

// ★ 这台 Windows 开发机上 mongodb-memory-server 第一次开库常常超过 jest 缺省的 5 秒（CLAUDE.md 记过）；只放宽本文件
jest.setTimeout(60_000);

let mongod;
let app;
let BranchVideo;
let BranchTemplate;
let TemplateReward;
let TokenLedger;
let Notification;
let User;
let DmRequestBlock;
let svc;
let cfg;
let wallet;

const HOUR = 3_600_000;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  delete process.env.TEMPLATE_REWARD_ENABLED;
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchVideo = require("../src/models/BranchVideo");
  BranchTemplate = require("../src/models/BranchTemplate");
  TemplateReward = require("../src/models/TemplateReward");
  TokenLedger = require("../src/models/TokenLedger");
  Notification = require("../src/models/Notification");
  User = require("../src/models/User");
  DmRequestBlock = require("../src/models/DmRequestBlock");
  svc = require("../src/services/templateReward.service");
  cfg = require("../src/config/templateReward");
  wallet = require("../src/services/tokenWallet.service");
  // 索引要真的建出来：唯一索引（恰好一次）与两条 partial 索引都是这套规则的一部分
  await Promise.all([TemplateReward.init(), BranchVideo.init(), BranchTemplate.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  delete process.env.TEMPLATE_REWARD_ENABLED;
  delete process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY;
  delete process.env.SUPPORT_NOTIFY_EMAIL;
  jest.restoreAllMocks();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `tr${seq}_${Date.now().toString(36)}`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: name, email: `${name}@test.local`, password: "secret123" })
    .expect(201);
  return { token: res.body.token, userId: String(res.body.user._id), name };
}

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

/** 一个最小的模板（形状抄 tests/branchRecipe.spec.js 的 seedTemplate） */
let tplSeq = 0;
async function seedTemplate(owner, { status = "published", title } = {}) {
  tplSeq += 1;
  const doc = await BranchTemplate.create({
    ownerId: owner.userId,
    title: title || `模板 ${tplSeq}`,
    recipe: { beats: ["一段"], durationSec: 5 },
    refVideo: {
      url: `https://res.cloudinary.com/demo/video/upload/ideahub/template-videos/tr-${tplSeq}.mp4`,
      durationSec: 5,
      width: 720,
      height: 1280,
      bytes: 1000,
      cloudinaryPublicId: `ideahub/template-videos/tr-${tplSeq}`,
    },
    status,
  });
  return String(doc._id);
}

async function publish(u, extra = {}) {
  const res = await request(app)
    .post("/api/branch/videos")
    .set(auth(u))
    .send({
      title: "模板奖励测试作品",
      category: "剧情",
      segments: [{ title: "成片", plot: "合并后的一整段", videoUrl: "https://cdn.example.com/m.mp4", durationSec: 10 }],
      ...extra,
    })
    .expect(201);
  return String(res.body.video._id);
}

/** 余额（plan + addon 分开看：奖励进的是 addon） */
async function balanceOf(u) {
  const w = await wallet.getWallet(u.userId);
  return { plan: w.plan, addon: w.addon, total: w.plan + w.addon, debt: w.debt };
}

/** 发布满 24 小时之后的那一刻（清扫器的钟是传进去的，不用真等） */
const due = (extraMs = 0) => new Date(Date.now() + cfg.HOLD_MS + 5 * 60_000 + extraMs);

/** 往判定表里垫 n 行「已经发过」的（上限用例用：真走 200 条作品太慢，而上限数的就是这张表） */
async function seedPaid({ author, template, user, n, decidedAt }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      video: new mongoose.Types.ObjectId(),
      template: template || new mongoose.Types.ObjectId(),
      author: author || new mongoose.Types.ObjectId(),
      user: user || new mongoose.Types.ObjectId(),
      status: "paid",
      tokens: cfg.TOKENS,
      decidedAt,
      paidAt: decidedAt,
      notifiedAt: decidedAt,
    });
  }
  await TemplateReward.insertMany(rows);
}

const rowOf = (video, template) => TemplateReward.findOne({ video, template }).lean();

describe("模板作者奖励", () => {
  test("规则端点：几个数与开关原样下发（键名按契约）；登录者带自己的小结；健康端点报能力位", async () => {
    const anon = await request(app).get("/api/branch/template-reward").expect(200);
    expect(anon.body.reward).toEqual({ enabled: true, tokens: 10_000, perAuthorPerDay: 20, perTemplate: 200, perUserPerDay: 3, holdMs: 24 * HOUR });
    expect(anon.body.mine).toBeUndefined();

    const u = await registerUser();
    const mine = await request(app).get("/api/branch/template-reward").set(auth(u)).expect(200);
    expect(mine.body.mine).toEqual({ count: 0, tokens: 0, last24h: 0 });

    process.env.TEMPLATE_REWARD_ENABLED = "false";
    const off = await request(app).get("/api/branch/template-reward").expect(200);
    expect(off.body.reward.enabled).toBe(false);

    const health = await request(app).get("/api/ark/health").expect(200);
    expect(health.body.templateReward).toBe(true);
  });

  test("账本类别：template_reward 在 enum 里，但既不抵欠额也不冲当日用量", async () => {
    expect(TokenLedger.TOKEN_REASONS).toContain("template_reward");
    expect(wallet.SPEND_REASONS).not.toContain("template_reward");
    const u = await registerUser();
    await wallet.getWallet(u.userId);
    await User.updateOne({ _id: u.userId }, { $set: { "tokenWallet.debt": 50_000, "tokenWallet.debtSince": new Date() } });
    const before = await balanceOf(u);
    await wallet.credit(u.userId, 10_000, "template_reward", "模板奖励 video:test tpl:test");
    const after = await balanceOf(u);
    expect(after.debt).toBe(50_000);
    expect(after.addon).toBe(before.addon + 10_000);
    expect(await wallet.spentToday(u.userId)).toBe(0);
  });

  test("W5 老发布体不带 templateIds：一格都不落、清扫器一条都不判（老 App 发的作品什么都不会发生）", async () => {
    const u = await registerUser();
    const id = await publish(u);
    const doc = await BranchVideo.findById(id).lean();
    expect(doc.templateIds).toBeUndefined();
    expect(doc.templateReward).toBeUndefined();
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ paid: 0 });
    expect(await TemplateReward.countDocuments({ video: id })).toBe(0);
  });

  test("W5 发布体：不存在的 id 丢掉、去重；全不存在就不落 pending；形状不对（非 24-hex / 超 20 个）整条 400", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const ghost = String(new mongoose.Types.ObjectId());
    const id = await publish(user, { templateIds: [tpl, ghost, tpl] });
    const doc = await BranchVideo.findById(id).lean();
    expect(doc.templateIds.map(String)).toEqual([tpl]);
    expect(doc.templateReward.pending).toBe(true);
    expect(doc.templateReward.at).toBeTruthy();
    // 回包不带内部记号，也不带 templateIds（它只给判定用）
    const got = await request(app).get(`/api/branch/videos/${id}`).expect(200);
    expect(JSON.stringify(got.body)).not.toContain("pending");
    expect(JSON.stringify(got.body)).not.toContain("templateIds");

    // 一个都不存在：发布时一格都不落（与老发布体同形，不留一个空数组）
    const none = await publish(user, { templateIds: [ghost] });
    const noneDoc = await BranchVideo.findById(none).lean();
    expect(noneDoc.templateIds).toBeUndefined();
    expect(noneDoc.templateReward).toBeUndefined();

    // 上面那条带 tpl 的作品到期照判（把它收掉，别让它漏到后面的用例里）
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 1, paid: 1 });
    expect(await TemplateReward.countDocuments({ video: id })).toBe(1);

    const bad = { title: "x", segments: [{ title: "成片", plot: "p", videoUrl: "https://cdn.example.com/m.mp4", durationSec: 10 }] };
    await request(app).post("/api/branch/videos").set(auth(user)).send({ ...bad, templateIds: ["not-an-id"] }).expect(400);
    await request(app)
      .post("/api/branch/videos")
      .set(auth(user))
      .send({ ...bad, templateIds: Array.from({ length: 21 }, () => String(new mongoose.Types.ObjectId())) })
      .expect(400);
  });

  test("W1+W3 不满 24 小时不判；到期发 10k 给模板作者，套模板的人的钱包不动；通知带着是谁、是哪条、是哪个模板", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author, { title: "被套用的模板" });
    const video = await publish(user, { templateIds: [tpl], title: "套着做的" });

    const a0 = await balanceOf(author);
    const u0 = await balanceOf(user);

    const early = await svc.sweepTemplateRewards({ now: new Date(Date.now() + cfg.HOLD_MS - HOUR) });
    expect(early).toMatchObject({ scanned: 0, paid: 0 });
    expect(await TemplateReward.countDocuments({ video })).toBe(0);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBe(true);

    const now = due();
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 1, paid: 1, skipped: 0, busy: 0, failed: 0 });

    const a1 = await balanceOf(author);
    const u1 = await balanceOf(user);
    expect(a1.addon).toBe(a0.addon + 10_000); // 进 addon，不进 plan
    // ★ 清扫拨到了第二天：那一拍免费版的每日额度会补进 plan（tokenWallet.ensureWallet）—— 奖励本身一分都不进 plan
    const daily = (await TokenLedger.find({ user: author.userId, reason: "daily_grant" }).lean()).reduce((n, r) => n + r.delta, 0);
    expect(a1.plan).toBe(a0.plan + daily);
    expect(u1).toEqual(u0); // ★ 套模板的人一个 token 都没动

    const ledger = await TokenLedger.find({ reason: "template_reward", user: author.userId }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 10_000, memo: `模板奖励 video:${video} tpl:${tpl}` });
    expect(await TokenLedger.countDocuments({ user: user.userId, reason: "template_reward" })).toBe(0);

    const row = await rowOf(video, tpl);
    expect(row).toMatchObject({ status: "paid", reason: "", tokens: 10_000 });
    expect(String(row.author)).toBe(author.userId);
    expect(String(row.user)).toBe(user.userId);
    expect(row.open).toBeUndefined();
    expect(row.notifiedAt).toBeTruthy();
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();

    const notes = await Notification.find({ userId: author.userId, type: "BRANCH_TEMPLATE_REWARD" }).lean();
    expect(notes).toHaveLength(1);
    expect(String(notes[0].actorId)).toBe(user.userId);
    expect(String(notes[0].videoId)).toBe(video);
    expect(notes[0].payload).toEqual({ tokens: 10_000, templateId: tpl, templateTitle: "被套用的模板", videoId: video, videoTitle: "套着做的" });
    const list = await request(app).get("/api/notifications?type=BRANCH_TEMPLATE_REWARD").set(auth(author)).expect(200);
    expect(list.body.items).toHaveLength(1);

    const mine = await request(app).get("/api/branch/template-reward").set(auth(author)).expect(200);
    expect(mine.body.mine).toMatchObject({ count: 1, tokens: 10_000, last24h: 1 });
  });

  test("W2 一条作品用了两个模板：各判一次、各发一次；重跑不重发；回炉重报同一个模板不再判、报新模板多判一对", async () => {
    const a1 = await registerUser();
    const a2 = await registerUser();
    const user = await registerUser();
    const t1 = await seedTemplate(a1);
    const t2 = await seedTemplate(a2);
    const video = await publish(user, { templateIds: [t1, t2] });
    const b1 = await balanceOf(a1);
    const b2 = await balanceOf(a2);
    const now = due();
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 1, paid: 2, skipped: 0 });
    expect((await balanceOf(a1)).addon).toBe(b1.addon + 10_000);
    expect((await balanceOf(a2)).addon).toBe(b2.addon + 10_000);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();

    const again = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + HOUR) });
    expect(again).toMatchObject({ scanned: 0, paid: 0, resumed: 0 });
    expect(await TokenLedger.countDocuments({ user: a1.userId, reason: "template_reward" })).toBe(1);

    // 回炉：重报 t1 + 新加 t3。t1 已判过（唯一索引），只多判 t3 一对；回炉不重新起算 24 小时（到期认 createdAt）
    const a3 = await registerUser();
    const t3 = await seedTemplate(a3);
    const rev = await request(app)
      .patch(`/api/branch/videos/${video}`)
      .set(auth(user))
      .send({ segments: [{ title: "成片 v2", plot: "换了内容", videoUrl: "https://cdn.example.com/m2.mp4", durationSec: 10 }], baseRevision: 0, templateIds: [t1, t3] })
      .expect(200);
    expect(rev.body.video.revision).toBe(1);
    const doc = await BranchVideo.findById(video).lean();
    expect(doc.templateIds.map(String)).toEqual([t1, t3]);
    expect(doc.templateReward.pending).toBe(true);
    const b3 = await balanceOf(a3);
    const third = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 2 * HOUR) });
    expect(third).toMatchObject({ scanned: 1, paid: 1, skipped: 0, done: 1 }); // t1 早判过：done，不算这一轮发的
    expect((await balanceOf(a1)).addon).toBe(b1.addon + 10_000); // t1 没有第二笔
    expect((await balanceOf(a3)).addon).toBe(b3.addon + 10_000);
    expect(await TemplateReward.countDocuments({ video })).toBe(3);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();

    // 之后作品被删也不追回；判定记录留着
    await request(app).delete(`/api/branch/videos/${video}`).set(auth(user)).expect(200);
    await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 3 * HOUR) });
    expect((await balanceOf(a1)).addon).toBe(b1.addon + 10_000);
    expect(await TemplateReward.countDocuments({ video })).toBe(3);
  });

  test("W5 改壳的 PATCH 只带 templateIds 也落得下（不算「没有字段」）", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(user);
    await request(app).patch(`/api/branch/videos/${video}`).set(auth(user)).send({ templateIds: [tpl] }).expect(200);
    const doc = await BranchVideo.findById(video).lean();
    expect(doc.templateIds.map(String)).toEqual([tpl]);
    expect(doc.templateReward.pending).toBe(true);
    expect(doc.revision || 0).toBe(0); // 改壳，不是回炉
    // 到期照判（收掉，别漏到后面的用例里）
    expect(await svc.sweepTemplateRewards({ now: due() })).toMatchObject({ scanned: 1, paid: 1 });
  });

  test("W5 到期锚点是挂上那一刻：给几周前发布的作品用改壳 PATCH 挂上模板 id，要等 PATCH 之后满 24 小时才判，不是下一轮就发", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(user);
    const weeksAgo = new Date(Date.now() - 21 * 24 * HOUR);
    await BranchVideo.updateOne({ _id: video }, { $set: { createdAt: weeksAgo } }, { timestamps: false });
    const before = Date.now();
    await request(app).patch(`/api/branch/videos/${video}`).set(auth(user)).send({ templateIds: [tpl] }).expect(200);
    const doc = await BranchVideo.findById(video).lean();
    expect(doc.templateReward.pending).toBe(true);
    expect(new Date(doc.templateReward.at).getTime()).toBeGreaterThanOrEqual(before - 1000); // at = 挂上那一刻，不是发布那一刻
    const b0 = await balanceOf(author);
    // 发布早就满 24 小时了，但挂上才一个小时：不判
    const early = await svc.sweepTemplateRewards({ now: new Date(Date.now() + HOUR) });
    expect(early).toMatchObject({ scanned: 0, paid: 0 });
    expect(await TemplateReward.countDocuments({ video })).toBe(0);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBe(true);
    expect(await balanceOf(author)).toEqual(b0);
    // 挂上满 24 小时：判
    const late = await svc.sweepTemplateRewards({ now: due() });
    expect(late).toMatchObject({ scanned: 1, paid: 1 });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 10_000);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();
  });

  test("W5 PATCH templateIds: [] 把清单清空、pending 原样留着；下一轮零行结案、摘掉 pending", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(user, { templateIds: [tpl] });
    const at0 = (await BranchVideo.findById(video).lean()).templateReward.at;
    await request(app).patch(`/api/branch/videos/${video}`).set(auth(user)).send({ templateIds: [] }).expect(200);
    const doc = await BranchVideo.findById(video).lean();
    expect(doc.templateIds).toEqual([]);
    expect(doc.templateReward.pending).toBe(true); // 不碰
    expect(new Date(doc.templateReward.at).getTime()).toBe(new Date(at0).getTime()); // at 也不碰
    const b0 = await balanceOf(author);
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 1, paid: 0, skipped: 0, busy: 0, failed: 0 });
    expect(await TemplateReward.countDocuments({ video })).toBe(0);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();
    expect(await balanceOf(author)).toEqual(b0);
  });

  test("W5 不是作者的 PATCH 带 templateIds：403，作品上一个字都没写（改壳 / 回炉两条路）", async () => {
    const author = await registerUser();
    const owner = await registerUser();
    const stranger = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(owner);
    await request(app).patch(`/api/branch/videos/${video}`).set(auth(stranger)).send({ templateIds: [tpl] }).expect(403);
    await request(app)
      .patch(`/api/branch/videos/${video}`)
      .set(auth(stranger))
      .send({ segments: [{ title: "成片", plot: "p", videoUrl: "https://cdn.example.com/x.mp4", durationSec: 10 }], baseRevision: 0, templateIds: [tpl] })
      .expect(403);
    const doc = await BranchVideo.findById(video).lean();
    expect(doc.templateIds).toBeUndefined();
    expect(doc.templateReward).toBeUndefined();
    expect(doc.revision || 0).toBe(0);
    expect(await svc.sweepTemplateRewards({ now: due() })).toMatchObject({ scanned: 0 });
  });

  test("W2 崩在占位之后：账本里没有这一笔 → 续办时补发一次；账本里已经有 → 只补状态不再发", async () => {
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const now = due();

    // 残局一：占到了，币没发
    const vA = await publish(user, { templateIds: [tpl] });
    await TemplateReward.create({ video: vA, template: tpl, author: author.userId, user: user.userId, status: "claimed", tokens: 10_000, decidedAt: now, open: true });
    const b0 = await balanceOf(author);
    // 刚占的（不到两分钟）不许接手：多半正在发，接手就是双发。作品上的 pending 也留着（这一对 busy）
    const tooSoon = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 30_000) });
    expect(tooSoon).toMatchObject({ resumed: 0, paid: 0, busy: 1 });
    expect(await balanceOf(author)).toEqual(b0);
    expect((await BranchVideo.findById(vA).lean()).templateReward.pending).toBe(true);
    const resumed = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + svc.CLAIM_STALE_MS + 1000) });
    expect(resumed.resumed).toBe(1);
    expect((await balanceOf(author)).addon).toBe(b0.addon + 10_000);
    expect(await rowOf(vA, tpl)).toMatchObject({ status: "paid" });
    expect((await BranchVideo.findById(vA).lean()).templateReward.pending).toBeUndefined();

    // 残局二：币发了（账本有那一条），状态没来得及改
    const other = await registerUser();
    const vB = await publish(other, { templateIds: [tpl] });
    await TemplateReward.create({ video: vB, template: tpl, author: author.userId, user: other.userId, status: "claimed", tokens: 10_000, decidedAt: now, open: true });
    await wallet.credit(author.userId, 10_000, "template_reward", svc.memoOf(vB, tpl));
    const b2 = await balanceOf(author);
    await svc.sweepTemplateRewards({ now: new Date(now.getTime() + svc.CLAIM_STALE_MS + 2000) });
    expect(await balanceOf(author)).toEqual(b2); // 没有第二笔
    expect(await TokenLedger.countDocuments({ user: author.userId, reason: "template_reward", memo: svc.memoOf(vB, tpl) })).toBe(1);
    const rowB = await rowOf(vB, tpl);
    expect(rowB.status).toBe("paid");
    expect(rowB.open).toBeUndefined();
    expect(await Notification.countDocuments({ userId: author.userId, type: "BRANCH_TEMPLATE_REWARD" })).toBe(2);
  });

  test("W3 自己套自己的模板：发布时照落 pending，判定时记成 self、不发", async () => {
    const author = await registerUser();
    const own = await seedTemplate(author);
    const video = await publish(author, { templateIds: [own] });
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBe(true);
    const b0 = await balanceOf(author);
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 1, paid: 0, skipped: 1 });
    expect(await rowOf(video, own)).toMatchObject({ status: "skipped", reason: "self", tokens: 0 });
    expect(await balanceOf(author)).toEqual(b0);
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBeUndefined();
  });

  test("W3 到期那一刻不公开的作品不发，而且就此定案（之后改回公开也不补）", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author);
    const b0 = await balanceOf(author);
    const priv = await publish(await registerUser(), { templateIds: [tpl], visibility: "private" });
    const link = await publish(await registerUser(), { templateIds: [tpl], visibility: "private", linkOnly: true });
    const down = await publish(await registerUser(), { templateIds: [tpl] });
    await BranchVideo.updateOne({ _id: down }, { $set: { takedown: { at: new Date(), reason: "test" } } });

    const now = due();
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 3, paid: 0, skipped: 3 });
    for (const id of [priv, link, down]) {
      expect(await rowOf(id, tpl)).toMatchObject({ status: "skipped", reason: "video_not_public", tokens: 0 });
      expect((await BranchVideo.findById(id).lean()).templateReward.pending).toBeUndefined();
    }
    expect(await balanceOf(author)).toEqual(b0);

    await BranchVideo.updateOne({ _id: priv }, { $set: { visibility: "public" } });
    const later = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 48 * HOUR) });
    expect(later.scanned).toBe(0);
    expect(await balanceOf(author)).toEqual(b0);
    expect(await Notification.countDocuments({ userId: author.userId, type: "BRANCH_TEMPLATE_REWARD" })).toBe(0);
  });

  test("W3 模板：删了 → template_gone；被平台下架 → template_blocked；退役（retired）照发", async () => {
    const author = await registerUser();
    const gone = await seedTemplate(author);
    const blocked = await seedTemplate(author, { status: "blocked" });
    const retired = await seedTemplate(author, { status: "retired" });
    const vGone = await publish(await registerUser(), { templateIds: [gone] });
    const vBlocked = await publish(await registerUser(), { templateIds: [blocked] });
    const vRetired = await publish(await registerUser(), { templateIds: [retired] });
    await BranchTemplate.deleteOne({ _id: gone });
    const b0 = await balanceOf(author);
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 3, paid: 1, skipped: 2 });
    expect(await rowOf(vGone, gone)).toMatchObject({ status: "skipped", reason: "template_gone" });
    expect(await rowOf(vBlocked, blocked)).toMatchObject({ status: "skipped", reason: "template_blocked" });
    expect(await rowOf(vRetired, retired)).toMatchObject({ status: "paid" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 10_000);
  });

  test("W3 被封 / 注销的账号：模板作者被封不发；使用者被封，他套的不算", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author);
    const banned = await registerUser();
    const vBanned = await publish(banned, { templateIds: [tpl] });
    await User.updateOne({ _id: banned.userId }, { $set: { banned: { at: new Date(), reason: "刷子号" } } });

    const gone = await registerUser();
    const tpl2 = await seedTemplate(gone);
    const vOk = await publish(await registerUser(), { templateIds: [tpl2] });
    await User.updateOne({ _id: gone.userId }, { $set: { deactivatedAt: new Date() } });

    const b0 = await balanceOf(author);
    await svc.sweepTemplateRewards({ now: due() });
    expect(await rowOf(vBanned, tpl)).toMatchObject({ status: "skipped", reason: "user_inactive" });
    expect(await rowOf(vOk, tpl2)).toMatchObject({ status: "skipped", reason: "author_inactive" });
    expect(await balanceOf(author)).toEqual(b0);
    expect(await TokenLedger.countDocuments({ user: gone.userId, reason: "template_reward" })).toBe(0);
  });

  test("W3 两人之间有拉黑（任一方向）：不发、记成 blocked、没有通知", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author);
    const u1 = await registerUser();
    const u2 = await registerUser();
    const v1 = await publish(u1, { templateIds: [tpl] });
    const v2 = await publish(u2, { templateIds: [tpl] });
    await DmRequestBlock.create({ blockerUserId: author.userId, blockedUserId: u1.userId }); // 作者拉黑了使用者
    await DmRequestBlock.create({ blockerUserId: u2.userId, blockedUserId: author.userId }); // 使用者拉黑了作者
    const b0 = await balanceOf(author);
    const out = await svc.sweepTemplateRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 2, paid: 0, skipped: 2 });
    expect(await rowOf(v1, tpl)).toMatchObject({ status: "skipped", reason: "blocked", tokens: 0 });
    expect(await rowOf(v2, tpl)).toMatchObject({ status: "skipped", reason: "blocked", tokens: 0 });
    expect(await balanceOf(author)).toEqual(b0);
    expect(await Notification.countDocuments({ userId: author.userId, type: "BRANCH_TEMPLATE_REWARD" })).toBe(0);
  });

  test("W4 每个模板 200 次：第 201 条不发；换一个模板不受影响", async () => {
    const author = await registerUser();
    const full = await seedTemplate(author);
    const fresh = await seedTemplate(author);
    const now = due();
    await seedPaid({ author: author.userId, template: full, n: cfg.PER_TEMPLATE, decidedAt: new Date(now.getTime() - 48 * HOUR) });
    const over = await publish(await registerUser(), { templateIds: [full] });
    const ok = await publish(await registerUser(), { templateIds: [fresh] });
    const b0 = await balanceOf(author);
    await svc.sweepTemplateRewards({ now });
    expect(await rowOf(over, full)).toMatchObject({ status: "skipped", reason: "template_cap" });
    expect(await rowOf(ok, fresh)).toMatchObject({ status: "paid" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 10_000);
  });

  test("W4 每位模板作者 24 小时内 20 次：到了上限的不顺延；窗口滑过去之后新到期的照发", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author);
    const now = due();
    await seedPaid({ author: author.userId, n: cfg.PER_AUTHOR_PER_DAY - 1, decidedAt: new Date(now.getTime() - 23 * HOUR) });
    const twentieth = await publish(await registerUser(), { templateIds: [tpl] });
    const twentyFirst = await publish(await registerUser(), { templateIds: [tpl] });
    const b0 = await balanceOf(author);
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 2, paid: 1, skipped: 1 });
    expect(await rowOf(twentieth, tpl)).toMatchObject({ status: "paid" });
    expect(await rowOf(twentyFirst, tpl)).toMatchObject({ status: "skipped", reason: "day_cap" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 10_000);
    const mine = await request(app).get("/api/branch/template-reward").set(auth(author)).expect(200);
    expect(mine.body.mine.count).toBe(cfg.PER_AUTHOR_PER_DAY);

    const later = await publish(await registerUser(), { templateIds: [tpl] });
    // 到期锚点是 max(createdAt, templateReward.at)：两个一起拨
    await BranchVideo.updateOne(
      { _id: later },
      { $set: { createdAt: new Date(now.getTime() - cfg.HOLD_MS), "templateReward.at": new Date(now.getTime() - cfg.HOLD_MS) } },
      { timestamps: false }
    );
    const out2 = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 2 * HOUR) });
    expect(out2).toMatchObject({ scanned: 1, paid: 1 });
    expect(await rowOf(twentyFirst, tpl)).toMatchObject({ status: "skipped", reason: "day_cap" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 20_000);
  });

  test("W4 防刷一：同一位使用者 24 小时内最多给别人带来 3 次，第 4 次不发；窗口滑过去之后照发、被挡的不补", async () => {
    expect(cfg.PER_USER_PER_DAY).toBe(3);
    const user = await registerUser();
    const authors = [];
    const videos = [];
    const tpls = [];
    for (let i = 0; i < 4; i++) {
      const a = await registerUser();
      authors.push(a);
      const t = await seedTemplate(a);
      tpls.push(t);
      videos.push(await publish(user, { templateIds: [t] }));
    }
    const last0 = await balanceOf(authors[3]);
    const now = due();
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 4, paid: 3, skipped: 1 });
    for (let i = 0; i < 3; i++) expect(await rowOf(videos[i], tpls[i])).toMatchObject({ status: "paid" });
    expect(await rowOf(videos[3], tpls[3])).toMatchObject({ status: "skipped", reason: "user_cap", tokens: 0 });
    expect(await balanceOf(authors[3])).toEqual(last0);

    const fifth = await registerUser();
    const t5 = await seedTemplate(fifth);
    const v5 = await publish(user, { templateIds: [t5] });
    const f0 = await balanceOf(fifth);
    const later = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + 25 * HOUR) });
    expect(later).toMatchObject({ scanned: 1, paid: 1 });
    expect(await rowOf(v5, t5)).toMatchObject({ status: "paid" });
    expect((await balanceOf(fifth)).addon).toBe(f0.addon + 10_000);
    expect(await rowOf(videos[3], tpls[3])).toMatchObject({ status: "skipped", reason: "user_cap" });
    expect(await balanceOf(authors[3])).toEqual(last0);
  });

  test("W4 防刷二：全站保险丝 —— 到了就不发并记成 budget；信没发出去下一条再试；一个窗口只发一封；额度调大之后照发", async () => {
    expect(cfg.globalPerDay()).toBe(200);
    process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY = "abc";
    expect(cfg.globalPerDay()).toBe(200);
    const email = require("../src/services/email.service");
    const send = jest.spyOn(email, "sendEmail").mockRejectedValueOnce(new Error("resend down")).mockResolvedValue({ ok: true });
    process.env.SUPPORT_NOTIFY_EMAIL = "ops@test.local";

    const pair = async () => {
      const author = await registerUser();
      const tpl = await seedTemplate(author);
      const video = await publish(await registerUser(), { templateIds: [tpl] });
      return { author, tpl, video };
    };
    const now = due();
    const liveAt = (t) => TemplateReward.countDocuments({ status: { $in: ["claimed", "paid"] }, decidedAt: { $gt: new Date(t.getTime() - 24 * HOUR) } });
    const used = await liveAt(now);
    process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY = String(used + 2);
    const a = await pair();
    const b = await pair();
    const c = await pair();
    const c0 = await balanceOf(c.author);
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 3, paid: 2, skipped: 1, failed: 0 });
    expect(await rowOf(a.video, a.tpl)).toMatchObject({ status: "paid" });
    expect(await rowOf(b.video, b.tpl)).toMatchObject({ status: "paid" });
    expect(await rowOf(c.video, c.tpl)).toMatchObject({ status: "skipped", reason: "budget", tokens: 0 });
    expect(await balanceOf(c.author)).toEqual(c0);
    expect((await BranchVideo.findById(c.video).lean()).templateReward.pending).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(["ops@test.local"]);
    expect(mail.subject).toContain(`${used + 2} 次`);
    expect(mail.text).toMatch(/收到奖励最多的模板作者：\n(  tr\d+_\w+  [0-9a-f]{24}  \d+ 次\n)+/);
    expect(mail.text).toMatch(/带来奖励最多的使用者：\n(  \S+  [0-9a-f]{24}  \d+ 次\n)+/);
    expect(mail.text).toContain("TEMPLATE_REWARD_GLOBAL_PER_DAY");

    const d = await pair();
    const t2 = new Date(now.getTime() + HOUR);
    process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY = String(await liveAt(t2));
    await svc.sweepTemplateRewards({ now: t2 });
    expect(await rowOf(d.video, d.tpl)).toMatchObject({ status: "skipped", reason: "budget" });
    expect(send).toHaveBeenCalledTimes(2);
    const e = await pair();
    const t3 = new Date(now.getTime() + 2 * HOUR);
    process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY = String(await liveAt(t3));
    await svc.sweepTemplateRewards({ now: t3 });
    expect(await rowOf(e.video, e.tpl)).toMatchObject({ status: "skipped", reason: "budget" });
    expect(send).toHaveBeenCalledTimes(2);

    const t4 = new Date(now.getTime() + 3 * HOUR);
    process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY = String((await liveAt(t4)) + 50);
    const f = await pair();
    const f0 = await balanceOf(f.author);
    const raised = await svc.sweepTemplateRewards({ now: t4 });
    expect(raised).toMatchObject({ scanned: 1, paid: 1 });
    expect((await balanceOf(f.author)).addon).toBe(f0.addon + 10_000);
    expect(await balanceOf(c.author)).toEqual(c0);
  });

  test("开关关着：到期的一律记成不发、不攒着；重新打开之后不补", async () => {
    const author = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(await registerUser(), { templateIds: [tpl] });
    expect((await BranchVideo.findById(video).lean()).templateReward.pending).toBe(true); // 关不关都照落待判
    const b0 = await balanceOf(author);
    process.env.TEMPLATE_REWARD_ENABLED = "false";
    const now = due();
    const out = await svc.sweepTemplateRewards({ now });
    expect(out).toMatchObject({ scanned: 1, paid: 0, skipped: 1 });
    expect(await rowOf(video, tpl)).toMatchObject({ status: "skipped", reason: "disabled" });
    delete process.env.TEMPLATE_REWARD_ENABLED;
    const reopened = await svc.sweepTemplateRewards({ now: new Date(now.getTime() + HOUR) });
    expect(reopened.scanned).toBe(0);
    expect(await balanceOf(author)).toEqual(b0);
  });

  test("W5 删号：只删「他是模板作者」的判定记录；「他是使用者」的留着（那是别人的上限计数）", async () => {
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const author = await registerUser();
    const user = await registerUser();
    const tpl = await seedTemplate(author);
    const video = await publish(user, { templateIds: [tpl] });
    await svc.sweepTemplateRewards({ now: due() });
    expect(await TemplateReward.countDocuments({ video })).toBe(1);

    await purgeUserCascade(user.userId);
    expect(await TemplateReward.countDocuments({ template: tpl, status: "paid" })).toBe(1);

    const removed = await purgeUserCascade(author.userId);
    expect(removed.templateRewards).toBe(1);
    expect(await TemplateReward.countDocuments({ author: author.userId })).toBe(0);
  });
});
