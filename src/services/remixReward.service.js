// src/services/remixReward.service.js
// 「同款奖励」的判定与发放 —— **唯一实现**（模板体系 P3b；四个数与开关在 config/remixReward.js，判定记录的形状在 models/RemixReward.js）。
//
// 一条同款的一生：
//   发布那一拍（branchVideo.controller 的 createVideo）→ 作品上落 `remixOf.pending: true`（自己按自己的流程做的不落）
//   → 满 24 小时后清扫器（index.js，只在 0 号实例，每 10 分钟一轮）来判一次：发 / 不发，写一行 RemixReward
//   → 发：`wallet.credit(原作者, N, "remix_reward")` + 一条 BRANCH_REMIX_REWARD 通知 → 摘掉 pending。
//   之后同款被删、被设成私密、被下架都**不追回**（追回要动负向分录，为 30k 不值得）。
//
// ══ 三条做错了不报错的事 ══════════════════════════════════════════════════════
//
// 【R1 恰好一次】先**占位**（RemixReward 的 remix 唯一索引，status: claimed）、再发币、再把占位改成 paid。
//    ★ 顺序反过来（先发币再落行）的话，崩在两步之间下一轮会再发一次；
//    ★ 只占位不留"还没办完"的记号的话，崩在占位之后这一笔就永远没人发了 —— 所以 claimed 的行带 `open`，
//      清扫器每轮先把搁浅的接着办完。币到底进没进账，只有**账本**说得清：memo 逐字是 `同款奖励 remix:<同款 id>`，
//      有这一条 = 进了，只补状态；没有 = 补发一次。（与 payment/play.service 的 sweepUnconsumed 同一招；
//      残留窗口也同一个：`credit` 内部是先 $inc 余额、再写流水，崩在那两步之间会重发 30k —— 毫秒级，另一边的代价是欠着不发。）
//    ★ 别人**刚**占的行（不到 CLAIM_STALE_MS）绝不接手：它多半正在发，接手就是双发。
//
// 【R2 上限不顺延】每位原作者 24 小时内最多 PER_AUTHOR_PER_DAY 次、每条原作一共 PER_VIDEO 次。到了上限的那几条
//    记成 skipped，**不排队等明天**：顺延的话"每天最多 10 次"只是限速，平台欠下的那一摞可以无限长，
//    而到期那一拍核过的事实（还公开着吗）等真发的时候早变了。上限数的是这张表里 claimed + paid 的行。
//    ★ 清扫器只在 0 号实例、且同一进程里不并发（下面的 `sweeping`），所以"数一下 → 占位"之间没有别人插进来。
//      真有两个进程同时跑（pm2 reload 新旧实例交接的那几秒）时上限可能多出一两条，同一条同款仍然只发一次（R1）。
//
// 【R3 判定只做一次】到期那一拍不满足的（私密、被下架、原作没了、上限到了……）就此定案，之后再变公开也不补。
//    这是有意的：规则写成"满 24 小时那一刻还公开着"，才说得清、也才查得清（RemixReward.reason）。
//
// 【R4 两道防刷（2026-10-03）】同款作者每人 24 小时内最多带来 PER_REMIXER_PER_DAY 次；全站 24 小时内最多发
//    globalPerDay() 次（保险丝）。两道都与 R2 同一个形状：数判定表、不顺延、判一次就定案。
//    ★ 保险丝排在**最后**判：记成 budget 的那几条是"别的都合格、只是全站的额度用完了"——查的人要能一眼分出
//      "被规则挡的"和"被保险丝挡的"，后者意味着要么被刷了、要么该把额度调大了（alertFuse 会发信）。
const mongoose = require("mongoose");
const BranchVideo = require("../models/BranchVideo");
const RemixReward = require("../models/RemixReward");
const TokenLedger = require("../models/TokenLedger");
const User = require("../models/User");
const wallet = require("./tokenWallet.service");
const { createNotification } = require("./notification.service");
const { hasAnyBlockBetween } = require("../utils/blocking");
const cfg = require("../config/remixReward");

/** 账本上的类别。★ 不在 REPAY_REASONS 里（印的钱不抵欠额），也不在 SPEND_REASONS 里（它不是消费的退回） */
const LEDGER_REASON = "remix_reward";
const NOTIFY_TYPE = "BRANCH_REMIX_REWARD";
/** 占位之后这么久还没办完，才算搁浅、允许别的一轮接手（R1 的最后一条 ★） */
const CLAIM_STALE_MS = 2 * 60 * 1000;
/** 通知补发最多追这么久：再久就不追了（币早就到了，一条迟到一天的通知只会让人困惑） */
const NOTIFY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 算进两道上限的行：占到的 + 发了的 */
const LIVE = ["claimed", "paid"];

/** 账本 memo —— **逐字**是「这笔币发没发」的证据（R1），改它等于让续办那一步认不出已经发过的 */
function memoOf(remixId) {
  return `同款奖励 remix:${remixId}`;
}

function isTakenDown(doc) {
  return !!(doc && doc.takedown && doc.takedown.at);
}

/** 账号还在用：没注销、没被封。★ 封号不自动藏内容（见 User.banned 的 ★），所以被封的人的同款要在这里挡 */
function activeUser(u) {
  return !!u && !u.deactivatedAt && !(u.banned && u.banned.at);
}

/**
 * 到期的这条同款发不发。回 null = 发；回字符串 = 不发的原因（RemixReward.SKIP_REASONS）。
 * ★ 顺序是有意的：先问便宜的、与别人无关的（开关 / 这条同款自己），再问原作与两个账号，最后才数上限 ——
 *   一条本来就不合格的同款不该写成 day_cap（查的人会以为"是上限挡的"）。
 */
async function verdictFor(remix, now) {
  if (!cfg.enabled()) return "disabled";
  const originalId = remix.remixOf.video;
  const authorId = remix.remixOf.author;
  if (String(remix.author) === String(authorId)) return "self";
  // 同款：必须**真公开**（凭链接可见的不算 —— 它不进任何列表，等于没人看得到）
  if (remix.visibility === "private" || isTakenDown(remix)) return "remix_not_public";
  // 原作：按 id 直取的口径（凭链接可见的算 —— 工作流模板可以挂在那种作品上，主人 10-02 拍板 5）
  const original = await BranchVideo.findById(originalId).select("visibility linkOnly takedown author").lean();
  if (!original || isTakenDown(original) || (original.visibility === "private" && original.linkOnly !== true)) {
    return "original_not_public";
  }
  const [author, remixer] = await Promise.all([
    User.findById(authorId).select("deactivatedAt banned").lean(),
    User.findById(remix.author).select("deactivatedAt banned").lean(),
  ]);
  if (!activeUser(author)) return "author_inactive";
  if (!activeUser(remixer)) return "remixer_inactive";
  // 同一个人对同一条原作只算一次（不然一个号对着一条原作发 50 条就把它的上限吃满了）
  if (await RemixReward.exists({ original: originalId, status: { $in: LIVE }, remixer: remix.author })) return "repeat";
  const since = new Date(now.getTime() - DAY_MS);
  // 防刷一：这位同款作者 24 小时内已经给别人带来够多次了（R4）
  if ((await RemixReward.countDocuments({ remixer: remix.author, status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.PER_REMIXER_PER_DAY) {
    return "remixer_cap";
  }
  if ((await RemixReward.countDocuments({ original: originalId, status: { $in: LIVE } })) >= cfg.PER_VIDEO) return "video_cap";
  if ((await RemixReward.countDocuments({ author: authorId, status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.PER_AUTHOR_PER_DAY) {
    return "day_cap";
  }
  // 防刷二：全站保险丝。★ 排在最后（R4 的 ★）
  if ((await RemixReward.countDocuments({ status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.globalPerDay()) return "budget";
  return null;
}

/** 上一次保险丝报警发出去的时刻（只在内存里：进程重启后同一个窗口里最多多发一封，不值得为它落库） */
let lastFuseAlertAt = 0;

/**
 * 保险丝断了：给管理员发一封信。**永不抛**（它是报警，不是主链路）。
 *
 * ★ 一个 24 小时窗口只发一封：断了之后每一条到期的同款都会走到这里，不去重就是每 10 分钟一封。
 * ★ **发成了才记**时间：信没发出去（邮件服务挂了 / 没配收件人）的话下一条 budget 再试 —— 报警静默失败 =
 *   奖励一直在被丢而没人知道。发不出去的每一次都在 pm2 日志里留一行 error。
 * ★ 信里带最近 24 小时收得最多 / 带来最多的各五个号：收到信的人第一件事是分清"被刷了"还是"真火了"，
 *   这两件事的处置相反（封号 / 把额度调大）。只写用户名与 id、不写昵称，用户名压成一行再进信 —— 纯文本邮件里
 *   用户可控的字符串能伪造出看起来像模板自带的行（同 nciiTakedown 的 oneLine；注册只管了用户名的长度，没管字符集）。
 */
async function alertFuse(now) {
  const limit = cfg.globalPerDay();
  console.error(`[remix-reward] 全站保险丝断了：最近 24 小时已发 ${limit} 次，之后到期的同款记成 budget 不发`);
  if (now.getTime() - lastFuseAlertAt < DAY_MS) return;
  try {
    const since = new Date(now.getTime() - DAY_MS);
    const top = (field) =>
      RemixReward.aggregate([
        { $match: { status: { $in: LIVE }, decidedAt: { $gt: since } } },
        { $group: { _id: `$${field}`, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 5 },
      ]);
    const [authors, remixers] = await Promise.all([top("author"), top("remixer")]);
    const users = await User.find({ _id: { $in: [...authors, ...remixers].map((r) => r._id) } }).select("username").lean();
    const nameOf = new Map(users.map((u) => [String(u._id), String(u.username || "").replace(/\s+/g, " ").slice(0, 40)]));
    const line = (r) => `  ${nameOf.get(String(r._id)) || "（账号不在了）"}  ${String(r._id)}  ${r.n} 次`;
    const text = [
      `同款奖励到了全站 24 小时上限（${limit} 次 = ${(limit * cfg.TOKENS).toLocaleString("en-US")} token）。`,
      "从现在起到窗口滑过去之前，到期的同款一律不发（记成 budget），之后也不补。",
      "",
      "最近 24 小时收到奖励最多的原作者：",
      ...authors.map(line),
      "",
      "最近 24 小时带来奖励最多的同款作者：",
      ...remixers.map(line),
      "",
      "怎么处置：",
      "  · 像是被刷了（几个号互相做同款）：后台封号 —— 被封的号到期的同款不算；要全停就把 REMIX_REWARD_ENABLED 设成 false。",
      "  · 是真的有这么多人在做同款：把 REMIX_REWARD_GLOBAL_PER_DAY 调大（环境变量，不用发版）。",
      "逐条记录在 remixrewards 集合里（status / reason / author / remixer / decidedAt）。",
    ].join("\n");
    const { adminRecipients } = require("./nciiTakedown.service");
    const { sendEmail } = require("./email.service");
    const to = await adminRecipients();
    if (!to.length) {
      console.error("[remix-reward] 保险丝报警没有可用的管理员邮箱（TAKEDOWN_NOTIFY_EMAIL / SUPPORT_NOTIFY_EMAIL / 管理员账号的邮箱）");
      return;
    }
    await sendEmail({ to, subject: `[启梦] 同款奖励到了全站 24 小时上限（${limit} 次）`, text });
    lastFuseAlertAt = now.getTime();
  } catch (err) {
    console.error("[remix-reward] 保险丝报警发信失败:", (err && err.message) || err);
  }
}

/**
 * 把一行 claimed 办成 paid（R1）。`resume` = 这一行不是我这一拍占到的，要先问账本发没发过。
 * ★ 原作者在占位之后被硬删了（credit 回 null）→ 改判 skipped: author_inactive，不留一行永远办不完的 claimed。
 */
async function pay(row, now, resume) {
  const memo = memoOf(row.remix);
  const already = resume ? await TokenLedger.exists({ user: row.author, reason: LEDGER_REASON, memo }) : null;
  if (!already) {
    const w = await wallet.credit(row.author, row.tokens, LEDGER_REASON, memo, now);
    if (!w) {
      await RemixReward.updateOne({ _id: row._id, status: "claimed" }, { $set: { status: "skipped", reason: "author_inactive", tokens: 0 }, $unset: { open: "" } });
      row.status = "skipped";
      row.open = undefined;
      return;
    }
    if (resume) console.warn(`[remix-reward] 补发 ${row.tokens} token（上一轮停在占位之后）remix=${row.remix} author=${row.author}`);
  }
  await RemixReward.updateOne({ _id: row._id, status: "claimed" }, { $set: { status: "paid", paidAt: now } });
  row.status = "paid";
  row.paidAt = now;
}

/**
 * 告诉原作者一声。失败会抛（调用方接住、这一行留着 open，下一轮再发）。
 *
 * ★ 拉黑闸与 branchVideo.controller 的 notifyBranch 同一口径（hasAnyBlockBetween，双向）：两人之间有拉黑时
 *   通知**不带是谁、也不带那条同款的链接**（App 画成「有人做了你的同款」）。不能干脆不发：币已经进账了，
 *   而 App 里没有流水页 —— 一笔说不出来历的余额变动比一条匿名通知糟。同款已经不在 / 不公开了也走这一档。
 * ★ 正文的金额在 `payload.tokens`（数），不拼成一句话放 commentText：通知是跨语言的，句子由 App 按界面语言说。
 */
async function notify(row, now) {
  const [remix, original, blocked] = await Promise.all([
    BranchVideo.findById(row.remix).select("title visibility takedown").lean(),
    BranchVideo.findById(row.original).select("title").lean(),
    hasAnyBlockBetween(row.remixer, row.author),
  ]);
  const base = { tokens: row.tokens, originalId: String(row.original), originalTitle: (original && original.title) || "" };
  const showRemix = !blocked && !!remix && remix.visibility !== "private" && !isTakenDown(remix);
  if (showRemix) {
    await createNotification({
      userId: row.author,
      actorId: row.remixer,
      videoId: row.remix,
      type: NOTIFY_TYPE,
      // payload 里那份 videoId / videoTitle 与其它 BRANCH_* 同形（老包读的是 payload，见 notifyBranch 的 ★）
      payload: { ...base, videoId: String(row.remix), videoTitle: remix.title || "" },
    });
  } else {
    await createNotification({ userId: row.author, type: NOTIFY_TYPE, payload: base });
  }
  await RemixReward.updateOne({ _id: row._id }, { $set: { notifiedAt: now } });
  row.notifiedAt = now;
}

/** 一行从"占到了"走到"办完了"：发币 → 摘掉作品上的 pending → 通知 → 摘掉 open。哪一步抛了，这一行都还带着 open */
async function finish(row, now, resume) {
  if (row.status === "claimed") await pay(row, now, resume);
  await BranchVideo.updateOne({ _id: row.remix, "remixOf.pending": true }, { $unset: { "remixOf.pending": "" } });
  if (row.status === "paid" && !row.notifiedAt) await notify(row, now);
  if (row.open) {
    await RemixReward.updateOne({ _id: row._id }, { $unset: { open: "" } });
    row.open = undefined;
  }
}

/** 判一条到期的同款。回 "paid" | "skipped" | "busy"（别人正在办） */
async function settleOne(remix, now) {
  let row = await RemixReward.findOne({ remix: remix._id }).lean();
  let mine = false; // 这一行是不是我这一拍占到的
  if (!row) {
    const reason = await verdictFor(remix, now);
    try {
      const doc = await RemixReward.create({
        remix: remix._id,
        original: remix.remixOf.video,
        author: remix.remixOf.author,
        remixer: remix.author,
        status: reason ? "skipped" : "claimed",
        reason: reason || "",
        tokens: reason ? 0 : cfg.TOKENS,
        decidedAt: now,
        ...(reason ? {} : { open: true }),
      });
      row = doc.toObject();
      mine = true;
      if (reason === "budget") await alertFuse(now);
    } catch (err) {
      // 唯一索引撞车 = 别的一轮刚占了这条（R1）。读回来按"不是我的"处理
      if (!err || err.code !== 11000) throw err;
      row = await RemixReward.findOne({ remix: remix._id }).lean();
      if (!row) return "busy";
    }
  }
  if (!mine && row.open && now.getTime() - new Date(row.decidedAt).getTime() < CLAIM_STALE_MS) return "busy";
  await finish(row, now, !mine);
  return row.status === "paid" ? "paid" : "skipped";
}

let sweeping = false;

/**
 * 清扫一轮。**永不抛**（它挂在定时器上，一条坏数据不该让后面的都没人判）；每一条各自 try。
 *   A. 先把搁浅的行接着办完（占到了没发 / 发了没通知）
 *   B. 再判到期的同款（发布满 HOLD_MS、作品上还带着 pending），按发布先后
 * @returns {Promise<{scanned:number, paid:number, skipped:number, busy:number, resumed:number, failed:number}|{running:true}>}
 */
async function sweepRemixRewards({ now = new Date(), limit = 200 } = {}) {
  if (sweeping) return { running: true }; // 同实例内不并发（R2 的 ★）
  sweeping = true;
  const out = { scanned: 0, paid: 0, skipped: 0, busy: 0, resumed: 0, failed: 0 };
  try {
    const stale = new Date(now.getTime() - CLAIM_STALE_MS);
    const open = await RemixReward.find({ open: true, decidedAt: { $lt: stale } }).sort({ decidedAt: 1 }).limit(limit).lean();
    for (const row of open) {
      try {
        await finish(row, now, true);
        out.resumed += 1;
      } catch (err) {
        out.failed += 1;
        console.error(`[remix-reward] 续办失败 remix=${row.remix}:`, (err && err.message) || err);
        // 币已经到了、只是通知一直发不出去：追一天就不追了，别让这一行每轮都响
        if (row.status === "paid" && now.getTime() - new Date(row.decidedAt).getTime() > NOTIFY_GIVE_UP_MS) {
          await RemixReward.updateOne({ _id: row._id }, { $unset: { open: "" } }).catch(() => {});
          console.error(`[remix-reward] 通知补发放弃 remix=${row.remix}（币已到账）`);
        }
      }
    }

    const due = await BranchVideo.find({ "remixOf.pending": true, createdAt: { $lte: new Date(now.getTime() - cfg.HOLD_MS) } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select("_id title author visibility linkOnly takedown remixOf createdAt")
      .lean();
    for (const remix of due) {
      out.scanned += 1;
      try {
        out[await settleOne(remix, now)] += 1;
      } catch (err) {
        out.failed += 1;
        console.error(`[remix-reward] 判定失败 remix=${remix._id}:`, (err && err.message) || err);
      }
    }
    if (out.paid || out.failed || out.resumed) {
      console.log(`[remix-reward] 一轮：到期 ${out.scanned}、发 ${out.paid}、不发 ${out.skipped}、续办 ${out.resumed}、失败 ${out.failed}`);
    }
  } catch (err) {
    console.error("[remix-reward] 清扫失败:", (err && err.message) || err);
  } finally {
    sweeping = false;
  }
  return out;
}

/**
 * 某个人作为原作者的小结（GET /api/branch/remix-reward 的 `mine`）：累计发了几次、多少 token，最近 24 小时用掉了几次上限。
 * ★ `last24h` 数的口径与 verdictFor 的那道上限**同一个**（claimed + paid、按 decidedAt）—— App 拿它说"今天还剩几次"。
 */
async function summaryFor(userId, now = new Date()) {
  // ★ aggregate 不替你转类型：传进来的是字符串的话 $match 一条都对不上、还不报错
  const author = new mongoose.Types.ObjectId(String(userId));
  const [totals, last24h] = await Promise.all([
    RemixReward.aggregate([
      { $match: { author, status: "paid" } },
      { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: "$tokens" } } },
    ]),
    RemixReward.countDocuments({ author, status: { $in: LIVE }, decidedAt: { $gt: new Date(now.getTime() - DAY_MS) } }),
  ]);
  const t = totals[0] || { count: 0, tokens: 0 };
  return { count: Number(t.count) || 0, tokens: Number(t.tokens) || 0, last24h };
}

module.exports = { sweepRemixRewards, summaryFor, memoOf, LEDGER_REASON, NOTIFY_TYPE, CLAIM_STALE_MS };
