// src/services/templateReward.service.js
// 「模板作者奖励」的判定与发放 —— **唯一实现**（主人 2026-10-30 拍板；几个数与开关在 config/templateReward.js，
// 判定记录的形状在 models/TemplateReward.js；设计正本 app 仓 docs/template-author-reward-design.md）。
//
// **照抄** remixReward.service：那边的 R1~R4 四条「做错了不报错的事」逐条适用，这里只记与同款不同的几处。
//
// 一条作品的一生：
//   发布 / 回炉那一拍（branchVideo.controller 的 resolveTemplateIds）→ 作品上落 `templateIds` + `templateReward.pending: true`
//   → 满 24 小时后清扫器（index.js，只在 0 号实例，每 10 分钟一轮）把它套过的**每一个**模板各判一次：发 / 不发，各写一行 TemplateReward
//   → 发：`wallet.credit(模板作者, N, "template_reward")` + 一条 BRANCH_TEMPLATE_REWARD 通知
//   → 这条作品的每一个模板都有了行（且都办完了）才摘掉作品上的 pending。
//   之后作品被删、被设成私密、被下架都**不追回**。
//
// ══ 与同款奖励的差别 ══════════════════════════════════════════════════════════
//
// 【主键是 (作品, 模板)】一条作品用了几个不同的模板就各判一次、各自占位（R1 恰好一次按这一对算）。回炉换内容再报一遍同一个模板 id
//    落不下第二行；报了新的模板 id 就多判一对。所以「摘 pending」不在 finish 里（同款那边是一行一条作品），
//    而在 settleVideo 把这条作品的每一对都走完之后 —— 有一对 busy（别的一轮正在办）就留着 pending，下一轮再来。
//
// 【拉黑 = 不发】规则写明「作者与模板作者之间没有拉黑」才发（设计正本第一节）；同款那边是币照发、只把通知匿名。
//    所以这里没有匿名通知那一支：发了币的通知一律带着是谁、是哪条作品。
//
// 【自己套自己的不发，但在判定时才排除】写入时只认 id 在不在（谁是模板作者是判定那一刻 BranchTemplate.ownerId 说了算）。
//
// 【三道上限】每位模板作者 24 小时内 PER_AUTHOR_PER_DAY 次、每个模板一共 PER_TEMPLATE 次、每个使用者 24 小时内带来 PER_USER_PER_DAY 次；
//    外加全站保险丝 globalPerDay()。都与 R2 / R4 同一个形状：数判定表、不顺延、判一次就定案、保险丝排在最后。
const mongoose = require("mongoose");
const BranchVideo = require("../models/BranchVideo");
const BranchTemplate = require("../models/BranchTemplate");
const TemplateReward = require("../models/TemplateReward");
const TokenLedger = require("../models/TokenLedger");
const User = require("../models/User");
const wallet = require("./tokenWallet.service");
const { createNotification } = require("./notification.service");
const { hasAnyBlockBetween } = require("../utils/blocking");
const cfg = require("../config/templateReward");

/** 账本上的类别。★ 不在 REPAY_REASONS 里（印的钱不抵欠额），也不在 SPEND_REASONS 里（它不是消费的退回） */
const LEDGER_REASON = "template_reward";
const NOTIFY_TYPE = "BRANCH_TEMPLATE_REWARD";
/** 占位之后这么久还没办完，才算搁浅、允许别的一轮接手（R1 的最后一条 ★） */
const CLAIM_STALE_MS = 2 * 60 * 1000;
/** 通知补发最多追这么久：再久就不追了（币早就到了，一条迟到一天的通知只会让人困惑） */
const NOTIFY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 算进三道上限的行：占到的 + 发了的 */
const LIVE = ["claimed", "paid"];

/** 账本 memo —— **逐字**是「这笔币发没发」的证据（R1），改它等于让续办那一步认不出已经发过的。契约里也写死了这一句 */
function memoOf(videoId, templateId) {
  return `模板奖励 video:${videoId} tpl:${templateId}`;
}

function isTakenDown(doc) {
  return !!(doc && doc.takedown && doc.takedown.at);
}

/** 账号还在用：没注销、没被封。★ 封号不自动藏内容（见 User.banned 的 ★），所以被封的人的作品要在这里挡 */
function activeUser(u) {
  return !!u && !u.deactivatedAt && !(u.banned && u.banned.at);
}

/**
 * 到期的这一对 (作品, 模板) 发不发。回 `{ reason: null, author }` = 发给 author；回 `{ reason, author? }` = 不发（TemplateReward.SKIP_REASONS）。
 * ★ 顺序是有意的（同 remixReward.verdictFor）：先问便宜的、与别人无关的（开关 / 这条作品自己），再问模板与两个账号，最后才数上限 ——
 *   一对本来就不合格的不该写成 day_cap（查的人会以为"是上限挡的"）。
 * ★ `author` 一并回去：模板没了就没有作者可记，这一行的 author 落成使用者自己（required 字段总得有值；status 是 skipped、tokens 0，不进任何上限计数 ——
 *   上限只数 LIVE 的行）。
 */
async function verdictFor(video, templateId, now) {
  const user = video.author;
  if (!cfg.enabled()) return { reason: "disabled", author: user };
  // 作品：必须**真公开**（凭链接可见的不算 —— 它不进任何列表，等于没人看得到）
  if (video.visibility === "private" || isTakenDown(video)) return { reason: "video_not_public", author: user };
  const tpl = await BranchTemplate.findById(templateId).select("ownerId status").lean();
  if (!tpl) return { reason: "template_gone", author: user };
  const author = tpl.ownerId;
  if (String(author) === String(user)) return { reason: "self", author };
  // ★ 只挡 blocked（平台下架）：retired（被公开流程引用、只能退役）与 pending（作者还没发布）照发 ——
  //   retired 的模板别人仍能拿来出片（契约「模板市场」那一节），pending 的只有作者自己能用、上一行 self 已经挡住了。
  if (tpl.status === "blocked") return { reason: "template_blocked", author };
  const [a, u, blocked] = await Promise.all([
    User.findById(author).select("deactivatedAt banned").lean(),
    User.findById(user).select("deactivatedAt banned").lean(),
    hasAnyBlockBetween(user, author),
  ]);
  if (!activeUser(a)) return { reason: "author_inactive", author };
  if (!activeUser(u)) return { reason: "user_inactive", author };
  if (blocked) return { reason: "blocked", author };
  const since = new Date(now.getTime() - DAY_MS);
  // 防刷一：这位使用者 24 小时内已经给别人带来够多次了（R4）
  if ((await TemplateReward.countDocuments({ user, status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.PER_USER_PER_DAY) {
    return { reason: "user_cap", author };
  }
  if ((await TemplateReward.countDocuments({ template: templateId, status: { $in: LIVE } })) >= cfg.PER_TEMPLATE) {
    return { reason: "template_cap", author };
  }
  if ((await TemplateReward.countDocuments({ author, status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.PER_AUTHOR_PER_DAY) {
    return { reason: "day_cap", author };
  }
  // 防刷二：全站保险丝。★ 排在最后（R4 的 ★）
  if ((await TemplateReward.countDocuments({ status: { $in: LIVE }, decidedAt: { $gt: since } })) >= cfg.globalPerDay()) {
    return { reason: "budget", author };
  }
  return { reason: null, author };
}

/** 上一次保险丝报警发出去的时刻（只在内存里：进程重启后同一个窗口里最多多发一封，不值得为它落库） */
let lastFuseAlertAt = 0;

/**
 * 保险丝断了：给管理员发一封信。**永不抛**（它是报警，不是主链路）。
 * 与 remixReward.alertFuse 同一套讲究：一个 24 小时窗口只发一封、发成了才记时间、信里带收得最多 / 带来最多的各五个号、
 * 用户名压成一行再进信。
 */
async function alertFuse(now) {
  const limit = cfg.globalPerDay();
  console.error(`[template-reward] 全站保险丝断了：最近 24 小时已发 ${limit} 次，之后到期的记成 budget 不发`);
  if (now.getTime() - lastFuseAlertAt < DAY_MS) return;
  try {
    const since = new Date(now.getTime() - DAY_MS);
    const top = (field) =>
      TemplateReward.aggregate([
        { $match: { status: { $in: LIVE }, decidedAt: { $gt: since } } },
        { $group: { _id: `$${field}`, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 5 },
      ]);
    const [authors, users] = await Promise.all([top("author"), top("user")]);
    const people = await User.find({ _id: { $in: [...authors, ...users].map((r) => r._id) } }).select("username").lean();
    const nameOf = new Map(people.map((u) => [String(u._id), String(u.username || "").replace(/\s+/g, " ").slice(0, 40)]));
    const line = (r) => `  ${nameOf.get(String(r._id)) || "（账号不在了）"}  ${String(r._id)}  ${r.n} 次`;
    const text = [
      `模板作者奖励到了全站 24 小时上限（${limit} 次 = ${(limit * cfg.TOKENS).toLocaleString("en-US")} token）。`,
      "从现在起到窗口滑过去之前，到期的一律不发（记成 budget），之后也不补。",
      "",
      "最近 24 小时收到奖励最多的模板作者：",
      ...authors.map(line),
      "",
      "最近 24 小时带来奖励最多的使用者：",
      ...users.map(line),
      "",
      "怎么处置：",
      "  · 像是被刷了（几个号互相套模板）：后台封号 —— 被封的号到期的作品不算；要全停就把 TEMPLATE_REWARD_ENABLED 设成 false。",
      "  · 是真的有这么多人在套模板：把 TEMPLATE_REWARD_GLOBAL_PER_DAY 调大（环境变量，不用发版）。",
      "逐条记录在 templaterewards 集合里（status / reason / author / user / decidedAt）。",
    ].join("\n");
    const { adminRecipients } = require("./nciiTakedown.service");
    const { sendEmail } = require("./email.service");
    const to = await adminRecipients();
    if (!to.length) {
      console.error("[template-reward] 保险丝报警没有可用的管理员邮箱（TAKEDOWN_NOTIFY_EMAIL / SUPPORT_NOTIFY_EMAIL / 管理员账号的邮箱）");
      return;
    }
    await sendEmail({ to, subject: `[启梦] 模板作者奖励到了全站 24 小时上限（${limit} 次）`, text });
    lastFuseAlertAt = now.getTime();
  } catch (err) {
    console.error("[template-reward] 保险丝报警发信失败:", (err && err.message) || err);
  }
}

/**
 * 把一行 claimed 办成 paid（R1）。`resume` = 这一行不是我这一拍占到的，要先问账本发没发过。
 * ★ 模板作者在占位之后被硬删了（credit 回 null）→ 改判 skipped: author_inactive，不留一行永远办不完的 claimed。
 */
async function pay(row, now, resume) {
  const memo = memoOf(row.video, row.template);
  const already = resume ? await TokenLedger.exists({ user: row.author, reason: LEDGER_REASON, memo }) : null;
  if (!already) {
    const w = await wallet.credit(row.author, row.tokens, LEDGER_REASON, memo, now);
    if (!w) {
      await TemplateReward.updateOne({ _id: row._id, status: "claimed" }, { $set: { status: "skipped", reason: "author_inactive", tokens: 0 }, $unset: { open: "" } });
      row.status = "skipped";
      row.open = undefined;
      return;
    }
    if (resume) console.warn(`[template-reward] 补发 ${row.tokens} token（上一轮停在占位之后）video=${row.video} tpl=${row.template} author=${row.author}`);
  }
  await TemplateReward.updateOne({ _id: row._id, status: "claimed" }, { $set: { status: "paid", paidAt: now } });
  row.status = "paid";
  row.paidAt = now;
}

/**
 * 告诉模板作者一声。失败会抛（调用方接住、这一行留着 open，下一轮再发）。
 * ★ 没有匿名那一支（拉黑的这一对在 verdictFor 就不发币了）。作品 / 模板标题现查：已经不在了就给空串，通知照发 —— 币已经进账了。
 * ★ 正文的金额在 `payload.tokens`（数），不拼成一句话：通知是跨语言的，句子由 App 按界面语言说。
 */
async function notify(row, now) {
  const [video, tpl] = await Promise.all([
    BranchVideo.findById(row.video).select("title").lean(),
    BranchTemplate.findById(row.template).select("title").lean(),
  ]);
  await createNotification({
    userId: row.author,
    actorId: row.user,
    videoId: row.video,
    type: NOTIFY_TYPE,
    payload: {
      tokens: row.tokens,
      templateId: String(row.template),
      templateTitle: (tpl && tpl.title) || "",
      videoId: String(row.video),
      videoTitle: (video && video.title) || "",
    },
  });
  await TemplateReward.updateOne({ _id: row._id }, { $set: { notifiedAt: now } });
  row.notifiedAt = now;
}

/** 一行从"占到了"走到"办完了"：发币 → 通知 → 摘掉 open。哪一步抛了，这一行都还带着 open。★ 不碰作品上的 pending（见文件头「主键是 (作品, 模板)」） */
async function finish(row, now, resume) {
  if (row.status === "claimed") await pay(row, now, resume);
  if (row.status === "paid" && !row.notifiedAt) await notify(row, now);
  if (row.open) {
    await TemplateReward.updateOne({ _id: row._id }, { $unset: { open: "" } });
    row.open = undefined;
  }
}

/**
 * 判一对到期的 (作品, 模板)。回 "paid" | "skipped" | "busy"（别人正在办）| "done"（早先那一轮就判过了、这一拍什么都没做）。
 * ★ "done" 是同款那边没有的一档：回炉重报同一个模板会让这条作品重新带着 pending 到期，而那一对的行早就在了 ——
 *   不单列的话它会被数成这一轮「发了一次」，日志与测试都会多出一笔其实没发的钱。
 */
async function settleOne(video, templateId, now) {
  let row = await TemplateReward.findOne({ video: video._id, template: templateId }).lean();
  let mine = false; // 这一行是不是我这一拍占到的
  if (row && !row.open) return "done";
  if (!row) {
    const { reason, author } = await verdictFor(video, templateId, now);
    try {
      const doc = await TemplateReward.create({
        video: video._id,
        template: templateId,
        author,
        user: video.author,
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
      // 唯一索引撞车 = 别的一轮刚占了这一对（R1）。读回来按"不是我的"处理
      if (!err || err.code !== 11000) throw err;
      row = await TemplateReward.findOne({ video: video._id, template: templateId }).lean();
      if (!row) return "busy";
    }
  }
  if (!mine && row.open && now.getTime() - new Date(row.decidedAt).getTime() < CLAIM_STALE_MS) return "busy";
  await finish(row, now, !mine);
  return row.status === "paid" ? "paid" : "skipped";
}

/**
 * 判一条到期的作品：它套过的每个模板各判一次；一对都不 busy 才摘掉作品上的 pending。
 * ★ 某一对抛了（库抖了一下）：别的对照判，这一对留给下一轮（pending 不摘）。一条作品里一个坏模板 id 不该让别的模板作者拿不到钱。
 * @returns {{paid:number, skipped:number, busy:number, done:number, failed:number}}
 */
async function settleVideo(video, now) {
  const out = { paid: 0, skipped: 0, busy: 0, done: 0, failed: 0 };
  const ids = Array.isArray(video.templateIds) ? video.templateIds : [];
  for (const templateId of ids) {
    try {
      out[await settleOne(video, templateId, now)] += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[template-reward] 判定失败 video=${video._id} tpl=${templateId}:`, (err && err.message) || err);
    }
  }
  if (!out.busy && !out.failed) {
    await BranchVideo.updateOne({ _id: video._id, "templateReward.pending": true }, { $unset: { "templateReward.pending": "" } });
  }
  return out;
}

let sweeping = false;

/**
 * 清扫一轮。**永不抛**（它挂在定时器上，一条坏数据不该让后面的都没人判）；每一条各自 try。
 *   A. 先把搁浅的行接着办完（占到了没发 / 发了没通知）
 *   B. 再判到期的作品（发布满 HOLD_MS、作品上还带着 pending），按发布先后；`scanned` 数的是作品、其余几格数的是 (作品, 模板) 对
 *      （`done` = 早先就判过的对，回炉重报同一个模板时会遇到）
 * @returns {Promise<{scanned:number, paid:number, skipped:number, busy:number, done:number, resumed:number, failed:number}|{running:true}>}
 */
async function sweepTemplateRewards({ now = new Date(), limit = 200 } = {}) {
  if (sweeping) return { running: true }; // 同实例内不并发（R2 的 ★）
  sweeping = true;
  const out = { scanned: 0, paid: 0, skipped: 0, busy: 0, done: 0, resumed: 0, failed: 0 };
  try {
    const stale = new Date(now.getTime() - CLAIM_STALE_MS);
    const open = await TemplateReward.find({ open: true, decidedAt: { $lt: stale } }).sort({ decidedAt: 1 }).limit(limit).lean();
    for (const row of open) {
      try {
        await finish(row, now, true);
        out.resumed += 1;
      } catch (err) {
        out.failed += 1;
        console.error(`[template-reward] 续办失败 video=${row.video} tpl=${row.template}:`, (err && err.message) || err);
        // 币已经到了、只是通知一直发不出去：追一天就不追了，别让这一行每轮都响
        if (row.status === "paid" && now.getTime() - new Date(row.decidedAt).getTime() > NOTIFY_GIVE_UP_MS) {
          await TemplateReward.updateOne({ _id: row._id }, { $unset: { open: "" } }).catch(() => {});
          console.error(`[template-reward] 通知补发放弃 video=${row.video} tpl=${row.template}（币已到账）`);
        }
      }
    }

    // ★ 到期认的是 createdAt（发布那一刻），不是 templateReward.at：回炉重报模板不重新起算 24 小时（作品本来就公开挂着）
    const due = await BranchVideo.find({ "templateReward.pending": true, createdAt: { $lte: new Date(now.getTime() - cfg.HOLD_MS) } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select("_id title author visibility linkOnly takedown templateIds createdAt")
      .lean();
    for (const video of due) {
      out.scanned += 1;
      try {
        const r = await settleVideo(video, now);
        out.paid += r.paid;
        out.skipped += r.skipped;
        out.busy += r.busy;
        out.done += r.done;
        out.failed += r.failed;
      } catch (err) {
        out.failed += 1;
        console.error(`[template-reward] 判定失败 video=${video._id}:`, (err && err.message) || err);
      }
    }
    if (out.paid || out.failed || out.resumed) {
      console.log(`[template-reward] 一轮：到期 ${out.scanned} 条作品、发 ${out.paid}、不发 ${out.skipped}、续办 ${out.resumed}、失败 ${out.failed}`);
    }
  } catch (err) {
    console.error("[template-reward] 清扫失败:", (err && err.message) || err);
  } finally {
    sweeping = false;
  }
  return out;
}

/**
 * 某个人作为模板作者的小结：累计发了几次、多少 token，最近 24 小时用掉了几次上限。
 * ★ `last24h` 数的口径与 verdictFor 的那道上限**同一个**（claimed + paid、按 decidedAt）。
 */
async function summaryFor(userId, now = new Date()) {
  // ★ aggregate 不替你转类型：传进来的是字符串的话 $match 一条都对不上、还不报错
  const author = new mongoose.Types.ObjectId(String(userId));
  const [totals, last24h] = await Promise.all([
    TemplateReward.aggregate([
      { $match: { author, status: "paid" } },
      { $group: { _id: null, count: { $sum: 1 }, tokens: { $sum: "$tokens" } } },
    ]),
    TemplateReward.countDocuments({ author, status: { $in: LIVE }, decidedAt: { $gt: new Date(now.getTime() - DAY_MS) } }),
  ]);
  const t = totals[0] || { count: 0, tokens: 0 };
  return { count: Number(t.count) || 0, tokens: Number(t.tokens) || 0, last24h };
}

module.exports = { sweepTemplateRewards, summaryFor, memoOf, LEDGER_REASON, NOTIFY_TYPE, CLAIM_STALE_MS };
