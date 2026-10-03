// tests/remixReward.spec.js
// 覆盖：同款奖励（模板体系 P3b）—— 别人按你的流程做了同款、公开发布满 24 小时还公开着，平台印一笔 token 给原作者。
// 实现：services/remixReward.service.js（判定与发放）、config/remixReward.js（四个数与开关）、models/RemixReward.js（判定记录）。
//
// ★ 这套用例盯的是五类【做错了不报错】的问题：
//   W1 钱的去向：只有原作者的 addon 多 30k；同款作者的钱包一个 token 都不动（token 不许在用户之间流转）；
//      这笔入账不抵欠额、不冲当日用量。
//   W2 恰好一次：清扫器重跑不重发；崩在「占位之后、进账之前 / 之后」的两种残局各自续办成一次。
//   W3 规则：不满 24 小时不判；到期那一刻不公开的、原作没了的、账号被封的、自己做自己的、同一个人第二次的都不发，
//      而且就此定案（之后再变公开也不补）。
//   W4 两道上限：每条原作 50 次、每位原作者 24 小时内 10 次；到了上限的不顺延。
//   W5 通知与级联：通知带着是谁、是哪条；有拉黑时不带；删号只删"他是原作者"的行。
//   W6 两道防刷（2026-10-03）：同款作者每人 24 小时内最多带来 3 次；全站保险丝到了就不发、一个窗口只报警一次、
//      信没发出去下一条再试。两个数都不进规则端点（不是产品承诺）。
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");

let mongod;
let app;
let BranchVideo;
let RemixReward;
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
  delete process.env.REMIX_REWARD_ENABLED;
  const { connectDB } = require("../src/config/db");
  await connectDB();
  app = require("../src/app");
  BranchVideo = require("../src/models/BranchVideo");
  RemixReward = require("../src/models/RemixReward");
  TokenLedger = require("../src/models/TokenLedger");
  Notification = require("../src/models/Notification");
  User = require("../src/models/User");
  DmRequestBlock = require("../src/models/DmRequestBlock");
  svc = require("../src/services/remixReward.service");
  cfg = require("../src/config/remixReward");
  wallet = require("../src/services/tokenWallet.service");
  // 索引要真的建出来：唯一索引（恰好一次）与两条 partial 索引都是这套规则的一部分
  await Promise.all([RemixReward.init(), BranchVideo.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(() => {
  delete process.env.REMIX_REWARD_ENABLED;
  delete process.env.REMIX_REWARD_GLOBAL_PER_DAY;
  delete process.env.SUPPORT_NOTIFY_EMAIL;
  jest.restoreAllMocks();
});

let seq = 0;
async function registerUser() {
  seq += 1;
  const name = `rr${seq}_${Date.now().toString(36)}`;
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
      title: "同款奖励测试作品",
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

/** 往判定表里垫 n 行「已经发过」的（上限用例用：真注册 50 个号太慢，而上限数的就是这张表） */
async function seedPaid({ author, original, n, decidedAt }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      remix: new mongoose.Types.ObjectId(),
      original: original || new mongoose.Types.ObjectId(),
      author,
      remixer: new mongoose.Types.ObjectId(),
      status: "paid",
      tokens: cfg.TOKENS,
      decidedAt,
      paidAt: decidedAt,
      notifiedAt: decidedAt,
    });
  }
  await RemixReward.insertMany(rows);
}

describe("同款奖励", () => {
  test("规则端点：四个数与开关原样下发；登录者带自己的小结", async () => {
    const anon = await request(app).get("/api/branch/remix-reward").expect(200);
    expect(anon.body.reward).toEqual({ enabled: true, tokens: 30_000, perDay: 10, perVideo: 50, holdHours: 24 });
    expect(anon.body.mine).toBeUndefined();

    const u = await registerUser();
    const mine = await request(app).get("/api/branch/remix-reward").set(auth(u)).expect(200);
    expect(mine.body.mine).toEqual({ count: 0, tokens: 0, last24h: 0 });

    process.env.REMIX_REWARD_ENABLED = "false";
    const off = await request(app).get("/api/branch/remix-reward").expect(200);
    expect(off.body.reward.enabled).toBe(false);
  });

  test("账本类别：remix_reward 在 enum 里，但既不抵欠额也不冲当日用量", async () => {
    expect(TokenLedger.TOKEN_REASONS).toContain("remix_reward");
    expect(wallet.SPEND_REASONS).not.toContain("remix_reward");
    // 欠着钱的人拿到奖励：欠额一分不少（印的钱不抵债，只有真付过钱的入账才抵）
    const u = await registerUser();
    await wallet.getWallet(u.userId);
    await User.updateOne({ _id: u.userId }, { $set: { "tokenWallet.debt": 50_000, "tokenWallet.debtSince": new Date() } });
    const before = await balanceOf(u);
    await wallet.credit(u.userId, 30_000, "remix_reward", "同款奖励 remix:test");
    const after = await balanceOf(u);
    expect(after.debt).toBe(50_000);
    expect(after.addon).toBe(before.addon + 30_000);
    expect(await wallet.spentToday(u.userId)).toBe(0);
  });

  test("W1+W3 发布那一拍只落「待判」；不满 24 小时不判；到期发 30k 给原作者，同款作者的钱包不动", async () => {
    const author = await registerUser();
    const remixer = await registerUser();
    const original = await publish(author);
    const remix = await publish(remixer, { remixOf: original, title: "照着做的" });

    const doc = await BranchVideo.findById(remix).lean();
    expect(doc.remixOf.pending).toBe(true);
    // 回包不带这一位（它是服务端的内部记号）
    const got = await request(app).get(`/api/branch/videos/${remix}`).expect(200);
    expect(JSON.stringify(got.body)).not.toContain("pending");

    const a0 = await balanceOf(author);
    const r0 = await balanceOf(remixer);

    // 还没到 24 小时：一条都不判
    const early = await svc.sweepRemixRewards({ now: new Date(Date.now() + cfg.HOLD_MS - HOUR) });
    expect(early).toMatchObject({ scanned: 0, paid: 0 });
    expect(await RemixReward.countDocuments({ remix })).toBe(0);

    const now = due();
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 1, paid: 1, skipped: 0, failed: 0 });

    const a1 = await balanceOf(author);
    const r1 = await balanceOf(remixer);
    expect(a1.addon).toBe(a0.addon + 30_000); // 进 addon（不过期），不进 plan
    expect(a1.plan).toBe(a0.plan);
    expect(r1).toEqual(r0); // ★ 同款作者一个 token 都没动

    const ledger = await TokenLedger.find({ reason: "remix_reward", user: author.userId }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ delta: 30_000, memo: `同款奖励 remix:${remix}` });
    expect(await TokenLedger.countDocuments({ user: remixer.userId, reason: "remix_reward" })).toBe(0);

    const row = await RemixReward.findOne({ remix }).lean();
    expect(row).toMatchObject({ status: "paid", reason: "", tokens: 30_000 });
    expect(String(row.author)).toBe(author.userId);
    expect(String(row.remixer)).toBe(remixer.userId);
    expect(row.open).toBeUndefined();
    expect(row.notifiedAt).toBeTruthy();
    expect((await BranchVideo.findById(remix).lean()).remixOf.pending).toBeUndefined();

    // 通知：带着是谁、是哪条同款，金额是数不是句子
    const notes = await Notification.find({ userId: author.userId, type: "BRANCH_REMIX_REWARD" }).lean();
    expect(notes).toHaveLength(1);
    expect(String(notes[0].actorId)).toBe(remixer.userId);
    expect(String(notes[0].videoId)).toBe(remix);
    expect(notes[0].payload).toMatchObject({ tokens: 30_000, originalId: original, videoId: remix, videoTitle: "照着做的" });
    // App 的通知列表按类型白名单查得到它
    const list = await request(app).get("/api/notifications?type=BRANCH_REMIX_REWARD").set(auth(author)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].videoId.title).toBe("照着做的");

    // 小结跟着变
    const mine = await request(app).get("/api/branch/remix-reward").set(auth(author)).expect(200);
    expect(mine.body.mine).toMatchObject({ count: 1, tokens: 30_000 });
  });

  test("W2 重跑不重发；之后同款被删也不追回", async () => {
    const author = await registerUser();
    const remixer = await registerUser();
    const original = await publish(author);
    const remix = await publish(remixer, { remixOf: original });
    const now = due();
    await svc.sweepRemixRewards({ now });
    const after1 = await balanceOf(author);
    const again = await svc.sweepRemixRewards({ now: new Date(now.getTime() + HOUR) });
    expect(again).toMatchObject({ scanned: 0, paid: 0, resumed: 0 });
    expect(await balanceOf(author)).toEqual(after1);
    expect(await TokenLedger.countDocuments({ user: author.userId, reason: "remix_reward" })).toBe(1);

    await request(app).delete(`/api/branch/videos/${remix}`).set(auth(remixer)).expect(200);
    await svc.sweepRemixRewards({ now: new Date(now.getTime() + 2 * HOUR) });
    expect(await balanceOf(author)).toEqual(after1);
    // 判定记录留着（审计 + 上限计数），哪怕那条同款已经不在了
    expect(await RemixReward.countDocuments({ remix })).toBe(1);
  });

  test("W2 崩在占位之后：账本里没有这一笔 → 续办时补发一次；账本里已经有 → 只补状态不再发", async () => {
    const author = await registerUser();
    const remixer = await registerUser();
    const original = await publish(author);
    const now = due();

    // 残局一：占到了，币没发
    const remixA = await publish(remixer, { remixOf: original });
    await RemixReward.create({ remix: remixA, original, author: author.userId, remixer: remixer.userId, status: "claimed", tokens: 30_000, decidedAt: now, open: true });
    const b0 = await balanceOf(author);
    // 刚占的（不到两分钟）不许接手：多半正在发，接手就是双发
    const tooSoon = await svc.sweepRemixRewards({ now: new Date(now.getTime() + 30_000) });
    expect(tooSoon).toMatchObject({ resumed: 0, paid: 0, busy: 1 });
    expect(await balanceOf(author)).toEqual(b0);
    const resumed = await svc.sweepRemixRewards({ now: new Date(now.getTime() + svc.CLAIM_STALE_MS + 1000) });
    expect(resumed.resumed).toBe(1);
    const b1 = await balanceOf(author);
    expect(b1.addon).toBe(b0.addon + 30_000);
    expect(await RemixReward.findOne({ remix: remixA }).lean()).toMatchObject({ status: "paid" });
    expect((await BranchVideo.findById(remixA).lean()).remixOf.pending).toBeUndefined();

    // 残局二：币发了（账本有那一条），状态没来得及改
    const other = await registerUser();
    const remixB = await publish(other, { remixOf: original });
    await RemixReward.create({ remix: remixB, original, author: author.userId, remixer: other.userId, status: "claimed", tokens: 30_000, decidedAt: now, open: true });
    await wallet.credit(author.userId, 30_000, "remix_reward", svc.memoOf(remixB));
    const b2 = await balanceOf(author);
    await svc.sweepRemixRewards({ now: new Date(now.getTime() + svc.CLAIM_STALE_MS + 2000) });
    expect(await balanceOf(author)).toEqual(b2); // 没有第二笔
    expect(await TokenLedger.countDocuments({ user: author.userId, reason: "remix_reward", memo: svc.memoOf(remixB) })).toBe(1);
    const rowB = await RemixReward.findOne({ remix: remixB }).lean();
    expect(rowB.status).toBe("paid");
    expect(rowB.open).toBeUndefined();
    // 通知也补上了（两条残局各一条）
    expect(await Notification.countDocuments({ userId: author.userId, type: "BRANCH_REMIX_REWARD" })).toBe(2);
  });

  test("W3 自己按自己的流程做：发布时就不落待判，永远不发", async () => {
    const author = await registerUser();
    const original = await publish(author);
    const again = await publish(author, { remixOf: original });
    const doc = await BranchVideo.findById(again).lean();
    expect(String(doc.remixOf.video)).toBe(original);
    expect(doc.remixOf.pending).toBeUndefined();
    const b0 = await balanceOf(author);
    await svc.sweepRemixRewards({ now: due() });
    expect(await balanceOf(author)).toEqual(b0);
    expect(await RemixReward.countDocuments({ remix: again })).toBe(0);
  });

  test("W3 到期那一刻不公开的同款不发，而且就此定案（之后改回公开也不补）", async () => {
    const author = await registerUser();
    const original = await publish(author);
    const b0 = await balanceOf(author);

    const r1 = await registerUser();
    const priv = await publish(r1, { remixOf: original, visibility: "private" });
    const r2 = await registerUser();
    const link = await publish(r2, { remixOf: original, visibility: "private", linkOnly: true });
    const r3 = await registerUser();
    const down = await publish(r3, { remixOf: original });
    await BranchVideo.updateOne({ _id: down }, { $set: { takedown: { at: new Date(), reason: "test" } } });
    const r4 = await registerUser();
    const gone = await publish(r4, { remixOf: original });
    await request(app).delete(`/api/branch/videos/${gone}`).set(auth(r4)).expect(200);

    const now = due();
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 3, paid: 0, skipped: 3 }); // 删掉的那条压根不在
    for (const id of [priv, link, down]) {
      expect(await RemixReward.findOne({ remix: id }).lean()).toMatchObject({ status: "skipped", reason: "remix_not_public", tokens: 0 });
      expect((await BranchVideo.findById(id).lean()).remixOf.pending).toBeUndefined();
    }
    expect(await balanceOf(author)).toEqual(b0);

    // 改回公开：不补
    await BranchVideo.updateOne({ _id: priv }, { $set: { visibility: "public" } });
    const later = await svc.sweepRemixRewards({ now: new Date(now.getTime() + 48 * HOUR) });
    expect(later.scanned).toBe(0);
    expect(await balanceOf(author)).toEqual(b0);
    expect(await Notification.countDocuments({ userId: author.userId, type: "BRANCH_REMIX_REWARD" })).toBe(0);
  });

  test("W3 原作：私密 / 被下架 / 被删 不发；凭链接可见的原作照发（工作流模板可以挂在那种作品上）", async () => {
    const author = await registerUser();
    const hidden = await publish(author);
    const taken = await publish(author);
    const deleted = await publish(author);
    const linkOnly = await publish(author, { visibility: "private", linkOnly: true });

    const mk = async (orig) => publish(await registerUser(), { remixOf: orig });
    const rHidden = await mk(hidden);
    const rTaken = await mk(taken);
    const rDeleted = await mk(deleted);
    const rLink = await mk(linkOnly);
    expect((await BranchVideo.findById(rLink).lean()).remixOf.pending).toBe(true);

    await BranchVideo.updateOne({ _id: hidden }, { $set: { visibility: "private" } });
    await BranchVideo.updateOne({ _id: taken }, { $set: { takedown: { at: new Date(), reason: "test" } } });
    await request(app).delete(`/api/branch/videos/${deleted}`).set(auth(author)).expect(200);

    const b0 = await balanceOf(author);
    const out = await svc.sweepRemixRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 4, paid: 1, skipped: 3 });
    for (const id of [rHidden, rTaken, rDeleted]) {
      expect(await RemixReward.findOne({ remix: id }).lean()).toMatchObject({ status: "skipped", reason: "original_not_public" });
    }
    expect(await RemixReward.findOne({ remix: rLink }).lean()).toMatchObject({ status: "paid" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 30_000);
  });

  test("W3 被封 / 注销的账号：原作者被封不发；同款作者被封，他的同款不算", async () => {
    const author = await registerUser();
    const original = await publish(author);
    const banned = await registerUser();
    const rBanned = await publish(banned, { remixOf: original });
    await User.updateOne({ _id: banned.userId }, { $set: { banned: { at: new Date(), reason: "刷子号" } } });

    const bannedAuthor = await registerUser();
    const original2 = await publish(bannedAuthor);
    const rOk = await publish(await registerUser(), { remixOf: original2 });
    await User.updateOne({ _id: bannedAuthor.userId }, { $set: { deactivatedAt: new Date() } });

    const b0 = await balanceOf(author);
    await svc.sweepRemixRewards({ now: due() });
    expect(await RemixReward.findOne({ remix: rBanned }).lean()).toMatchObject({ status: "skipped", reason: "remixer_inactive" });
    expect(await RemixReward.findOne({ remix: rOk }).lean()).toMatchObject({ status: "skipped", reason: "author_inactive" });
    expect(await balanceOf(author)).toEqual(b0);
    expect(await TokenLedger.countDocuments({ user: bannedAuthor.userId, reason: "remix_reward" })).toBe(0);
  });

  test("W3 同一个人对同一条原作只算一次；换一条原作再算", async () => {
    const author = await registerUser();
    const remixer = await registerUser();
    const o1 = await publish(author);
    const o2 = await publish(author);
    const first = await publish(remixer, { remixOf: o1 });
    const second = await publish(remixer, { remixOf: o1 });
    const third = await publish(remixer, { remixOf: o2 });
    const b0 = await balanceOf(author);
    const out = await svc.sweepRemixRewards({ now: due() });
    expect(out).toMatchObject({ scanned: 3, paid: 2, skipped: 1 });
    expect(await RemixReward.findOne({ remix: first }).lean()).toMatchObject({ status: "paid" });
    expect(await RemixReward.findOne({ remix: second }).lean()).toMatchObject({ status: "skipped", reason: "repeat" });
    expect(await RemixReward.findOne({ remix: third }).lean()).toMatchObject({ status: "paid" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 60_000);
  });

  test("W4 每条原作 50 次：第 51 条不发；换一条原作不受影响", async () => {
    const author = await registerUser();
    const full = await publish(author);
    const fresh = await publish(author);
    const now = due();
    // 垫 50 行两天前发的（不占 24 小时那道上限）
    await seedPaid({ author: author.userId, original: full, n: cfg.PER_VIDEO, decidedAt: new Date(now.getTime() - 48 * HOUR) });
    const over = await publish(await registerUser(), { remixOf: full });
    const ok = await publish(await registerUser(), { remixOf: fresh });
    const b0 = await balanceOf(author);
    await svc.sweepRemixRewards({ now });
    expect(await RemixReward.findOne({ remix: over }).lean()).toMatchObject({ status: "skipped", reason: "video_cap" });
    expect(await RemixReward.findOne({ remix: ok }).lean()).toMatchObject({ status: "paid" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 30_000);
  });

  test("W4 每位原作者 24 小时内 10 次：到了上限的不顺延；窗口滑过去之后新的同款照发", async () => {
    const author = await registerUser();
    const original = await publish(author);
    const now = due();
    // 23 小时前已经发过 9 次（各是不同的原作）
    await seedPaid({ author: author.userId, n: cfg.PER_AUTHOR_PER_DAY - 1, decidedAt: new Date(now.getTime() - 23 * HOUR) });
    const tenth = await publish(await registerUser(), { remixOf: original });
    const eleventh = await publish(await registerUser(), { remixOf: original });
    const b0 = await balanceOf(author);
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 2, paid: 1, skipped: 1 });
    // 按发布先后：先发布的那条拿到第 10 次
    expect(await RemixReward.findOne({ remix: tenth }).lean()).toMatchObject({ status: "paid" });
    expect(await RemixReward.findOne({ remix: eleventh }).lean()).toMatchObject({ status: "skipped", reason: "day_cap" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 30_000);
    const mine = await request(app).get("/api/branch/remix-reward").set(auth(author)).expect(200);
    expect(mine.body.mine.count).toBe(cfg.PER_AUTHOR_PER_DAY); // 9 + 1

    // 两小时后那 9 次滑出窗口：被 day_cap 挡下的那条**不补**，但新到期的同款照发
    const laterRemix = await publish(await registerUser(), { remixOf: original });
    await BranchVideo.updateOne({ _id: laterRemix }, { $set: { createdAt: new Date(now.getTime() - cfg.HOLD_MS) } }, { timestamps: false });
    const later = await svc.sweepRemixRewards({ now: new Date(now.getTime() + 2 * HOUR) });
    expect(later).toMatchObject({ scanned: 1, paid: 1 });
    expect(await RemixReward.findOne({ remix: eleventh }).lean()).toMatchObject({ status: "skipped", reason: "day_cap" });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 60_000);
  });

  test("开关关着：到期的一律记成不发、不攒着；重新打开之后不补", async () => {
    const author = await registerUser();
    const original = await publish(author);
    const remix = await publish(await registerUser(), { remixOf: original });
    expect((await BranchVideo.findById(remix).lean()).remixOf.pending).toBe(true); // 关不关都照落待判
    const b0 = await balanceOf(author);
    process.env.REMIX_REWARD_ENABLED = "false";
    const now = due();
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 1, paid: 0, skipped: 1 });
    expect(await RemixReward.findOne({ remix }).lean()).toMatchObject({ status: "skipped", reason: "disabled" });
    delete process.env.REMIX_REWARD_ENABLED;
    const reopened = await svc.sweepRemixRewards({ now: new Date(now.getTime() + HOUR) });
    expect(reopened.scanned).toBe(0);
    expect(await balanceOf(author)).toEqual(b0);
  });

  test("W5 两人之间有拉黑：币照发，通知不带是谁、也不带那条同款", async () => {
    const author = await registerUser();
    const remixer = await registerUser();
    const original = await publish(author, { title: "被照着做的原作" });
    const remix = await publish(remixer, { remixOf: original });
    await DmRequestBlock.create({ blockerUserId: author.userId, blockedUserId: remixer.userId });
    const b0 = await balanceOf(author);
    await svc.sweepRemixRewards({ now: due() });
    expect((await balanceOf(author)).addon).toBe(b0.addon + 30_000);
    const notes = await Notification.find({ userId: author.userId, type: "BRANCH_REMIX_REWARD" }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0].actorId == null).toBe(true);
    expect(notes[0].videoId == null).toBe(true);
    expect(notes[0].payload).toEqual({ tokens: 30_000, originalId: original, originalTitle: "被照着做的原作" });
    expect(JSON.stringify(notes[0])).not.toContain(remix);
    expect(JSON.stringify(notes[0])).not.toContain(remixer.userId);
  });

  test("W6 防刷一：同一位同款作者 24 小时内最多带来 3 次，第 4 次不发；窗口滑过去之后照发、被挡的不补", async () => {
    expect(cfg.PER_REMIXER_PER_DAY).toBe(3);
    const remixer = await registerUser();
    const authors = [];
    const remixes = [];
    for (let i = 0; i < 4; i++) {
      const a = await registerUser();
      authors.push(a);
      remixes.push(await publish(remixer, { remixOf: await publish(a) }));
    }
    const last0 = await balanceOf(authors[3]);
    const now = due();
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 4, paid: 3, skipped: 1 });
    // 按发布先后：前三条发，第四条被这道挡下
    for (const id of remixes.slice(0, 3)) expect(await RemixReward.findOne({ remix: id }).lean()).toMatchObject({ status: "paid" });
    expect(await RemixReward.findOne({ remix: remixes[3] }).lean()).toMatchObject({ status: "skipped", reason: "remixer_cap", tokens: 0 });
    expect(await balanceOf(authors[3])).toEqual(last0);

    // 25 小时后前三次滑出窗口：这个人新发的同款照算；被挡下的那条不补
    const fifth = await registerUser();
    const r5 = await publish(remixer, { remixOf: await publish(fifth) });
    const f0 = await balanceOf(fifth);
    const later = await svc.sweepRemixRewards({ now: new Date(now.getTime() + 25 * HOUR) });
    expect(later).toMatchObject({ scanned: 1, paid: 1 });
    expect(await RemixReward.findOne({ remix: r5 }).lean()).toMatchObject({ status: "paid" });
    expect((await balanceOf(fifth)).addon).toBe(f0.addon + 30_000);
    expect(await RemixReward.findOne({ remix: remixes[3] }).lean()).toMatchObject({ status: "skipped", reason: "remixer_cap" });
    expect(await balanceOf(authors[3])).toEqual(last0);
  });

  test("W6 防刷二：全站保险丝 —— 到了就不发并记成 budget；信没发出去下一条再试；一个窗口只发一封；额度调大之后照发", async () => {
    expect(cfg.globalPerDay()).toBe(100); // 缺省
    process.env.REMIX_REWARD_GLOBAL_PER_DAY = "abc";
    expect(cfg.globalPerDay()).toBe(100); // 写坏了按缺省，不会变成 0 次或无限
    const email = require("../src/services/email.service");
    const send = jest.spyOn(email, "sendEmail").mockRejectedValueOnce(new Error("resend down")).mockResolvedValue({ ok: true });
    process.env.SUPPORT_NOTIFY_EMAIL = "ops@test.local";

    const pair = async () => {
      const author = await registerUser();
      const remix = await publish(await registerUser(), { remixOf: await publish(author) });
      return { author, remix };
    };
    const now = due();
    // 窗口是滑动的（别的用例垫的行会滑出去），所以每一轮都按「那一刻窗口里已有的」现定额度
    const liveAt = (t) => RemixReward.countDocuments({ status: { $in: ["claimed", "paid"] }, decidedAt: { $gt: new Date(t.getTime() - 24 * HOUR) } });
    // 第一轮：已有的 + 2 ⇒ 三条里只有前两条发得出去
    const used = await liveAt(now);
    process.env.REMIX_REWARD_GLOBAL_PER_DAY = String(used + 2);
    const a = await pair();
    const b = await pair();
    const c = await pair();
    const c0 = await balanceOf(c.author);
    const out = await svc.sweepRemixRewards({ now });
    expect(out).toMatchObject({ scanned: 3, paid: 2, skipped: 1, failed: 0 });
    expect(await RemixReward.findOne({ remix: a.remix }).lean()).toMatchObject({ status: "paid" });
    expect(await RemixReward.findOne({ remix: b.remix }).lean()).toMatchObject({ status: "paid" });
    expect(await RemixReward.findOne({ remix: c.remix }).lean()).toMatchObject({ status: "skipped", reason: "budget", tokens: 0 });
    expect(await balanceOf(c.author)).toEqual(c0);
    expect((await BranchVideo.findById(c.remix).lean()).remixOf.pending).toBeUndefined(); // 判一次就定案
    // 第一封信试过了（这一发被我们弄失败了）：收件人、标题里的额度、正文里的用户名
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(["ops@test.local"]);
    expect(mail.subject).toContain(`${used + 2} 次`);
    // 正文里列着最近 24 小时收得最多 / 带来最多的号（用户名 + id + 次数），供分清「被刷了」还是「真火了」
    expect(mail.text).toMatch(/收到奖励最多的原作者：\n(  rr\d+_\w+  [0-9a-f]{24}  \d+ 次\n)+/);
    expect(mail.text).toMatch(/带来奖励最多的同款作者：\n(  \S+  [0-9a-f]{24}  \d+ 次\n)+/);
    expect(mail.text).toContain("REMIX_REWARD_GLOBAL_PER_DAY");

    // 同一个窗口里又断一次：上一封没发出去 → 再试一次，这次成了
    const d = await pair();
    const t2 = new Date(now.getTime() + HOUR);
    process.env.REMIX_REWARD_GLOBAL_PER_DAY = String(await liveAt(t2)); // 额度正好用完
    await svc.sweepRemixRewards({ now: t2 });
    expect(await RemixReward.findOne({ remix: d.remix }).lean()).toMatchObject({ status: "skipped", reason: "budget" });
    expect(send).toHaveBeenCalledTimes(2);
    // 再断一次：发成过了，这个窗口里不再发
    const e = await pair();
    const t3 = new Date(now.getTime() + 2 * HOUR);
    process.env.REMIX_REWARD_GLOBAL_PER_DAY = String(await liveAt(t3));
    await svc.sweepRemixRewards({ now: t3 });
    expect(await RemixReward.findOne({ remix: e.remix }).lean()).toMatchObject({ status: "skipped", reason: "budget" });
    expect(send).toHaveBeenCalledTimes(2);

    // 把额度调大（环境变量，不用发版）：新到期的照发；被保险丝挡下的那几条不补
    const t4 = new Date(now.getTime() + 3 * HOUR);
    process.env.REMIX_REWARD_GLOBAL_PER_DAY = String((await liveAt(t4)) + 50);
    const f = await pair();
    const f0 = await balanceOf(f.author);
    const raised = await svc.sweepRemixRewards({ now: t4 });
    expect(raised).toMatchObject({ scanned: 1, paid: 1 });
    expect((await balanceOf(f.author)).addon).toBe(f0.addon + 30_000);
    expect(await balanceOf(c.author)).toEqual(c0);
  });

  test("W5 删号：只删「他是原作者」的判定记录；「他是同款作者」的留着（那是别人的上限计数）", async () => {
    const { purgeUserCascade } = require("../src/controllers/branchAdmin.controller");
    const author = await registerUser();
    const remixer = await registerUser();
    const original = await publish(author);
    const remix = await publish(remixer, { remixOf: original });
    await svc.sweepRemixRewards({ now: due() });
    expect(await RemixReward.countDocuments({ remix })).toBe(1);

    // 同款作者注销：行留着 —— 同一条原作的上限计数不能被"做完同款就删号"清零
    await purgeUserCascade(remixer.userId);
    expect(await RemixReward.countDocuments({ original, status: "paid" })).toBe(1);

    const removed = await purgeUserCascade(author.userId);
    expect(removed.remixRewards).toBe(1);
    expect(await RemixReward.countDocuments({ author: author.userId })).toBe(0);
  });
});
