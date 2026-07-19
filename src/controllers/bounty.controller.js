// src/controllers/bounty.controller.js
// 赏金猎人（Bounty Hunter）控制器：悬赏任务的增删改查、提交/审批、讨论评论。
//
// ★赏金 = 平台【虚拟点数】，不是真钱：无现金价值，不可提现/兑换，不做任何真实支付/转账。
//
// ══ 点数是怎么流动的（改这个文件前必读）══════════════════════════════
// 发布 → 从发布者账上把 reward×slots 扣进【托管】（Bounty.escrowPoints，镜像账本里 user:null 的分录）
// 审批 → 从托管付给猎人
// 关闭/完成/删除 → 把没用完的托管退还发布者（只退一次）
//
// 三条硬不变量（错了不会报错，只会悄悄多印钱或少给人钱），细节见 services/points.service.js：
//   I1 除 signup 外每次变动都成对写账且和为零
//   I2 一切扣减/发放用条件原子更新，严禁读-改-写
//   I3 退款幂等（Bounty.refundedAt）
//
// ══ 本文件对「审批终态」的取舍 ════════════════════════════════════
// approved 是【终态】：不允许 approved → rejected。
// 原因：点数一旦入了猎人的账，就撤不回来了 —— 猎人可能已经花掉，硬倒扣要么把余额扣成负数
// （min:0 会让条件更新失败），要么得凭空印钱补上。
// 副作用（是好事）：approvedCount 只增不减，于是既有的「名额空出来就把 completed 退回 open」
// 这条可逆路径自然消失 —— 否则「退款后又收到新审批」就会去透支一个已经空了的托管账户。
const mongoose = require("mongoose");
const Bounty = require("../models/Bounty");
const BountySubmission = require("../models/BountySubmission");
const BountyComment = require("../models/BountyComment");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const {
  toPoints,
  holdEscrow,
  payEscrowToHunter,
  refundEscrowToPoster,
  settleBountyEscrow,
  creditUser,
} = require("../services/points.service");
const PointsLedger = require("../models/PointsLedger");

const PLATFORMS = ["weibo", "bilibili", "tieba", "zhihu", "douyin", "xiaohongshu", "instagram", "other"];
const STATUSES = ["open", "closed", "completed"];

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function readPage(req) {
  const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10) || 12, 1), 40);
  return { page, limit };
}

function normalizePlatform(input) {
  const value = String(input || "").trim().toLowerCase();
  return PLATFORMS.includes(value) ? value : "other";
}

function normalizeSafeUrl(input) {
  const raw = String(input || "").trim().slice(0, 2000);
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return "";

  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
}

function toTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  }
  return [...new Set(
    String(raw || "")
      .split(/[#,，,\s|]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 12);
}

function parseDeadline(input) {
  if (input === null || input === undefined || String(input).trim() === "") return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeSlots(input) {
  return Math.max(1, parseInt(input, 10) || 1);
}

/**
 * reward 归一化：必须是非负整数点数。
 * ★这里不再用 Number(x || 0) 兜底：reward 现在直接决定托管要扣多少点，
 *   一个 NaN 混进来就会写出 escrowPoints:NaN，之后所有 $gte 判断全部失效（NaN 比什么都不大也不小），
 *   托管从此既发不出也退不回。宁可 400。
 */
function readReward(input) {
  const value = toPoints(input);
  if (value === null) badRequest("赏金点数必须是 0 或正整数");
  return value;
}

function serializeUserRef(u) {
  if (u && typeof u === "object" && u.username !== undefined) {
    return { _id: u._id, username: u.username };
  }
  return u;
}

function ownedBy(doc, user) {
  return !!user && String(user._id) === String(doc.author?._id || doc.author);
}

// ── 序列化（严格对齐冻结契约的字段/形状）──────────────────────────

function serializeSubmission(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    bounty: doc.bounty,
    hunter: serializeUserRef(doc.hunter),
    speechText: doc.speechText || "",
    screenshotUrl: doc.screenshotUrl || "",
    note: doc.note || "",
    status: doc.status || "pending",
    // 审批那一刻实际入账的点数（账本真值）。前端用它渲染「已入账 N 点」，
    // 而不是拿 bounty.reward 去猜 —— reward 事后可改，猜出来的数会和账本不符。
    awardedPoints: Number(doc.awardedPoints || 0),
    createdAt: doc.createdAt,
  };
}

function serializeComment(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: serializeUserRef(doc.author),
    text: doc.text || "",
    imageUrl: doc.imageUrl || "",
    parentId: doc.parentId || null,
    createdAt: doc.createdAt,
  };
}

function toBountyPayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: serializeUserRef(doc.author),
    title: doc.title || "",
    description: doc.description || "",
    reward: Number(doc.reward || 0),
    platform: doc.platform || "other",
    targetUrl: doc.targetUrl || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    slots: Number(doc.slots || 1),
    status: doc.status || "open",
    deadline: doc.deadline || null,
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      submissionCount: Number(doc?.stats?.submissionCount || 0),
      commentCount: Number(doc?.stats?.commentCount || 0),
    },
    approvedCount: Number(doc.approvedCount || 0),
    isOwner: !!ctx.isOwner,
    mySubmission: ctx.mySubmission !== undefined ? ctx.mySubmission : null,
    // 托管余额只给发布者看：那是他自己被扣下来的点数，别人无需知道。
    escrowPoints: ctx.isOwner ? Number(doc.escrowPoints || 0) : undefined,
    // 已结算（托管已退回）→ 终态：不能再审批/重开/改赏金
    refundedAt: doc.refundedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toBountyCard(doc, ctx = {}) {
  const payload = toBountyPayload(doc, ctx);
  if (!payload) return null;
  const { description, mySubmission, ...card } = payload;
  return card;
}

async function loadMySubmission(bountyId, userId) {
  if (!userId) return null;
  const subs = await BountySubmission.find({ bounty: bountyId, hunter: userId })
    .sort({ createdAt: -1 })
    .populate("hunter", "_id username")
    .lean();
  if (!subs.length) return null;
  const active = subs.find((s) => s.status !== "rejected");
  return serializeSubmission(active || subs[0]);
}

// ── list ─────────────────────────────────────────────────────────

async function listBounties(req, res, next) {
  try {
    const { page, limit } = readPage(req);
    const sort = String(req.query.sort || "new").toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const tag = String(req.query.tag || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim().toLowerCase();

    const filter = {};
    if (tag) filter.tags = tag;
    if (STATUSES.includes(status)) filter.status = status;

    let items = await Bounty.find(filter).populate("author", "_id username").lean();

    if (q) {
      items = items.filter((item) => {
        const hay = `${item.title || ""} ${item.description || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (sort === "hot") {
      items.sort((a, b) => {
        const sa = Number(a?.stats?.submissionCount || 0) + Number(a?.stats?.viewCount || 0);
        const sb = Number(b?.stats?.submissionCount || 0) + Number(b?.stats?.viewCount || 0);
        if (sb !== sa) return sb - sa;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else {
      items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    }

    const total = items.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const paged = items.slice((page - 1) * limit, page * limit);

    res.json({
      ok: true,
      bounties: paged.map((item) => toBountyCard(item, { isOwner: ownedBy(item, req.user) })),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function listMyBounties(req, res, next) {
  try {
    const { page, limit } = readPage(req);

    const filter = { author: req.user._id };
    const total = await Bounty.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const items = await Bounty.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("author", "_id username")
      .lean();

    res.json({
      ok: true,
      bounties: items.map((item) => toBountyCard(item, { isOwner: true })),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function getBountyDetail(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const existing = await Bounty.findById(id).select("_id").lean();
    if (!existing) notFound("Bounty not found");

    await Bounty.updateOne({ _id: id }, { $inc: { "stats.viewCount": 1 } });
    const refreshed = await Bounty.findById(id).populate("author", "_id username").lean();

    const isOwner = ownedBy(refreshed, req.user);
    const mySubmission = req.user ? await loadMySubmission(id, req.user._id) : null;

    res.json({
      ok: true,
      bounty: toBountyPayload(refreshed, { isOwner, mySubmission }),
    });
  } catch (err) {
    next(err);
  }
}

// 发布悬赏 = 把 reward × slots 从发布者账上托管起来。
//
// ★顺序是【先扣款，再建悬赏】，中途失败就把扣款原样退回。
//   两种坏情况都必须不可能发生：
//     「悬赏建了但没扣款」→ 平台凭空承诺了它没托管的点数（= 印钱）
//     「扣了款但没悬赏」  → 吞掉用户的点数（= 少给人钱）
//   先扣款还能在余额不足时快速失败，不会留下孤儿悬赏文档。
//   bountyId 提前生成，这样扣款分录在悬赏建出来之前就能带上正确的 bounty 引用。
async function createBounty(req, res, next) {
  try {
    const reward = readReward(req.body.reward);
    const slots = normalizeSlots(req.body.slots);
    const hold = reward * slots;
    const bountyId = new mongoose.Types.ObjectId();

    // 余额不足 → 400，且【什么都没写】：悬赏不会被创建
    await holdEscrow({
      bountyId,
      posterId: req.user._id,
      amount: hold,
      memo: `发布悬赏托管 ${reward} × ${slots} 名额`,
    });

    let doc;
    try {
      doc = await Bounty.create({
        _id: bountyId,
        author: req.user._id,
        title: String(req.body.title || "").trim().slice(0, 120),
        description: String(req.body.description || "").trim().slice(0, 5000),
        reward,
        platform: normalizePlatform(req.body.platform),
        targetUrl: normalizeSafeUrl(req.body.targetUrl),
        tags: toTags(req.body.tags),
        slots,
        deadline: parseDeadline(req.body.deadline),
        escrowPoints: hold,
      });
    } catch (err) {
      // 建悬赏失败 → 把这笔托管完整回滚成「从没发生过」。
      // bountyId 是刚生成的、全库唯一，所以按 bounty 清账本分录不会误伤别人的账。
      await PointsLedger.deleteMany({ bounty: bountyId });
      await Bounty.deleteOne({ _id: bountyId });
      if (hold > 0) await creditUser(req.user._id, hold);
      throw err;
    }

    const populated = await Bounty.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, bounty: toBountyPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

// 改 reward / slots 就是在改「这个悬赏还要发出去多少点」，托管必须跟着一起改，
// 否则托管和承诺对不上：调高了不补扣 → 审批时发现付不出，猎人白干；
//                      调低了不退还 → 发布者的点数被白白锁死。
// 目标托管 = reward × 剩余名额（slots - approvedCount）。
//
// ★整个函数改用 $set 更新，【不再】 doc.save()：doc 是在补扣/退款之前读出来的，
//   save() 会把内存里那份过期的 escrowPoints 整个写回去，把刚刚原子改好的托管覆盖掉。
async function updateBounty(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id)
      .select("author reward slots approvedCount escrowPoints refundedAt")
      .lean();
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    const $set = {};
    if (req.body.title !== undefined) $set.title = String(req.body.title || "").trim().slice(0, 120);
    if (req.body.description !== undefined) $set.description = String(req.body.description || "").trim().slice(0, 5000);
    if (req.body.platform !== undefined) $set.platform = normalizePlatform(req.body.platform);
    if (req.body.targetUrl !== undefined) $set.targetUrl = normalizeSafeUrl(req.body.targetUrl);
    if (req.body.tags !== undefined) $set.tags = toTags(req.body.tags);
    if (req.body.deadline !== undefined) $set.deadline = parseDeadline(req.body.deadline);

    const changesMoney = req.body.reward !== undefined || req.body.slots !== undefined;
    let diff = 0;

    if (changesMoney) {
      const approvedCount = Number(doc.approvedCount || 0);
      const nextReward = req.body.reward !== undefined ? readReward(req.body.reward) : Number(doc.reward || 0);
      const nextSlots = req.body.slots !== undefined ? normalizeSlots(req.body.slots) : Number(doc.slots || 1);

      // 已结算 = 托管已经退回发布者，这个悬赏是终态了。再让人改赏金，就得凭空重新托管一次。
      if (doc.refundedAt) badRequest("该悬赏已结算并退还托管点数，不能再修改赏金点数或名额");
      // 名额调到比已通过数还少 → 剩余名额为负 → 目标托管为负，托管会被算成要"倒扣"
      if (nextSlots < approvedCount) badRequest("名额不能少于已通过的提交数");

      $set.reward = nextReward;
      $set.slots = nextSlots;
      diff = nextReward * (nextSlots - approvedCount) - Number(doc.escrowPoints || 0);
    }
    // ★只在 reward/slots 真的被改时才动托管：否则改个标题都会重算一遍托管，
    //   已结算悬赏（托管 0）会因为"目标托管 = reward × 剩余名额 > 0"被莫名其妙地再扣一次款。

    if (diff > 0) {
      // 调高 → 先补扣（不够就 400，悬赏保持原样），再把新值和托管一起写进去
      await holdEscrow({ bountyId: id, posterId: req.user._id, amount: diff, memo: "调整悬赏，追加托管点数" });
      const bumped = await Bounty.findOneAndUpdate(
        { _id: id, refundedAt: null },
        { $set, $inc: { escrowPoints: diff } },
        { new: true }
      ).lean();
      if (!bumped) {
        // 窄竞态：补扣成功的同时悬赏被结算了 → 把刚扣的原样退回，别把用户的点数吞在一个终态悬赏里
        await refundEscrowToPoster({
          bountyId: id,
          posterId: req.user._id,
          amount: diff,
          memo: "悬赏已结算，退回本次追加的托管点数",
        });
        badRequest("该悬赏已结算并退还托管点数，不能再修改赏金点数或名额");
      }
    } else if (diff < 0) {
      // 调低 → 先原子地把多余的托管claim走（escrowPoints 够才claim，claim不到就别退），再退给发布者。
      // 顺序反过来（先退款再claim）就会在并发时把同一笔托管退两次。
      const claimed = await Bounty.findOneAndUpdate(
        { _id: id, refundedAt: null, escrowPoints: { $gte: -diff } },
        { $set, $inc: { escrowPoints: diff } },
        { new: true }
      ).lean();
      if (!claimed) badRequest("托管点数状态已变化，请刷新后重试");
      await refundEscrowToPoster({
        bountyId: id,
        posterId: req.user._id,
        amount: -diff,
        memo: "调整悬赏，退还多余的托管点数",
      });
    } else if (Object.keys($set).length > 0) {
      await Bounty.updateOne({ _id: id }, { $set });
    }

    const populated = await Bounty.findById(id).populate("author", "_id username").lean();
    res.json({ ok: true, bounty: toBountyPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function removeBounty(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id).select("author").lean();
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    // ★删之前必须先把托管退回发布者，否则这些点数会跟着悬赏一起消失 —— 用户凭空少了钱。
    //   幂等，删一个已结算过的悬赏不会再退第二次。
    //   账本分录【不删】：它是历史，删了 sum(delta) 就不再等于 sum(signup)（I1）。
    await settleBountyEscrow(id, "删除悬赏，退还未使用的托管点数");

    await Promise.all([
      Bounty.deleteOne({ _id: id }),
      BountySubmission.deleteMany({ bounty: id }),
      BountyComment.deleteMany({ bounty: id }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// closed / completed = 不再接收提交 → 把没用完的托管退还发布者。
//
// ★退款【必须幂等】（I3）：反复点「关闭」不得反复退款，反复退款就是凭空印钱。
//   幂等不在这里做，而在 settleBountyEscrow 里用 refundedAt 的条件原子更新抢占，
//   所以这里放心地每次都调用它。
async function setBountyStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id).select("author status refundedAt").lean();
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    const nextStatus = req.body.status;

    // 已结算的悬赏不能设回「进行中」：托管已经空了，猎人来提交也拿不到赏金
    // （审批会因托管不足而失败），等于挂一块骗人的牌子。
    if (nextStatus === "open" && doc.refundedAt) {
      badRequest("该悬赏已结算并退还托管点数，不能重新开启");
    }

    await Bounty.updateOne({ _id: id }, { $set: { status: nextStatus } });

    if (nextStatus === "closed" || nextStatus === "completed") {
      await settleBountyEscrow(
        id,
        nextStatus === "closed" ? "关闭悬赏，退还未使用的托管点数" : "完成悬赏，退还未使用的托管点数"
      );
    }

    const populated = await Bounty.findById(id).populate("author", "_id username").lean();
    res.json({ ok: true, bounty: toBountyPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function listSubmissions(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const bounty = await Bounty.findById(id).select("_id author").lean();
    if (!bounty) notFound("Bounty not found");

    const isOwner = ownedBy(bounty, req.user);
    const filter = { bounty: id };
    if (!isOwner) filter.hunter = req.user._id; // 非 owner 只见自己的

    const { page, limit } = readPage(req);
    const total = await BountySubmission.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const items = await BountySubmission.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("hunter", "_id username")
      .lean();

    res.json({
      ok: true,
      submissions: items.map(serializeSubmission),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function submitBounty(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const bounty = await Bounty.findById(id).select("_id author status").lean();
    if (!bounty) notFound("Bounty not found");
    if (String(bounty.author) === String(req.user._id)) badRequest("Cannot submit to your own bounty");
    if (bounty.status !== "open") badRequest("This bounty is no longer accepting submissions");

    const speechText = String(req.body.speechText || "").trim().slice(0, 4000);
    const screenshotUrl = normalizeSafeUrl(req.body.screenshotUrl);
    const note = String(req.body.note || "").trim().slice(0, 2000);

    // 每人对同一 bounty 只允许一条“未拒绝”的提交：更新其 pending 那条或报错
    const existing = await BountySubmission.findOne({
      bounty: id,
      hunter: req.user._id,
      status: { $in: ["pending", "approved"] },
    });

    if (existing) {
      if (existing.status === "approved") badRequest("Your submission was already approved");
      existing.speechText = speechText;
      existing.screenshotUrl = screenshotUrl;
      existing.note = note;
      await existing.save();
      const populated = await BountySubmission.findById(existing._id).populate("hunter", "_id username").lean();
      return res.json({ ok: true, submission: serializeSubmission(populated) });
    }

    const doc = await BountySubmission.create({
      bounty: id,
      hunter: req.user._id,
      speechText,
      screenshotUrl,
      note,
      status: "pending",
    });
    await Bounty.updateOne({ _id: id }, { $inc: { "stats.submissionCount": 1 } });

    const populated = await BountySubmission.findById(doc._id).populate("hunter", "_id username").lean();
    res.status(201).json({ ok: true, submission: serializeSubmission(populated) });
  } catch (err) {
    next(err);
  }
}

async function respondWithSubmission(res, sid) {
  const populated = await BountySubmission.findById(sid).populate("hunter", "_id username").lean();
  res.json({ ok: true, submission: serializeSubmission(populated) });
}

// 审批通过 = 从托管把 reward 付给猎人。这是整个功能里最容易悄悄出错的地方。
//
// ★不超付（I2）全靠下面第 2 步那一个原子更新。三个闸门（未结算 / 名额未满 / 托管够）
//  和两个扣减（approvedCount+1 / escrowPoints-reward）必须挤在【同一条】 findOneAndUpdate 里：
//  单文档更新是串行的，所以并发审批时后到的那个一定看到已经扣过的托管和已经 +1 的名额。
//  一旦拆成「先查再判再存」，两个请求就会同时通过判断 —— 名额超发、托管透支。
//
// ★这里用聚合管道更新（[{$set:...}]）而不是普通 $inc：条件和扣减都直接引用文档自己的
//  $reward / $slots，不掺任何在别处读到的旧值。否则并发改 reward 时会按旧价付款。
async function approveSubmission(res, id, sid) {
  // 1) 原子占坑：把这条提交从 pending/rejected 改成 approved。
  //    抢不到 = 它已经是 approved（重复点/并发重复提交）→ 幂等返回，绝不二次付款。
  //    new:false → 拿到改之前的状态，闸门没过时要照原样回滚。
  const prevSub = await BountySubmission.findOneAndUpdate(
    { _id: sid, bounty: id, status: { $ne: "approved" } },
    { $set: { status: "approved" } },
    { new: false }
  ).lean();

  if (!prevSub) {
    const current = await BountySubmission.findById(sid).select("_id status").lean();
    if (!current) notFound("Submission not found");
    return respondWithSubmission(res, sid); // 已通过过了，什么都不做
  }

  // 2) 原子闸门 + 扣托管（见上方注释：不超付的唯一保证）
  const gated = await Bounty.findOneAndUpdate(
    {
      _id: id,
      refundedAt: null, // 已结算 = 托管已退回发布者，再付款就是透支
      $expr: {
        $and: [
          { $lt: ["$approvedCount", "$slots"] }, // 名额封顶（既有行为，保留）
          { $gte: ["$escrowPoints", "$reward"] }, // 托管不足一律拒绝，不得透支
        ],
      },
    },
    [
      {
        $set: {
          approvedCount: { $add: ["$approvedCount", 1] },
          escrowPoints: { $subtract: ["$escrowPoints", "$reward"] },
        },
      },
    ],
    // updatePipeline: true —— mongoose 9 要求显式声明"这个 update 是聚合管道"，不写会直接抛错
    { new: true, updatePipeline: true }
  )
    .select("reward slots approvedCount escrowPoints refundedAt")
    .lean();

  if (!gated) {
    // 闸门没过 → 提交状态原样回滚，再按真实原因报错
    await BountySubmission.updateOne({ _id: sid }, { $set: { status: prevSub.status } });

    const fresh = await Bounty.findById(id).select("approvedCount slots escrowPoints reward refundedAt").lean();
    if (!fresh) notFound("Bounty not found");
    if (fresh.refundedAt) badRequest("该悬赏已结算并退还托管点数，无法再审批通过");
    if (Number(fresh.approvedCount || 0) >= Number(fresh.slots || 1)) badRequest("Bounty already fully approved");
    badRequest("该悬赏的托管点数不足，无法发放赏金");
  }

  // 3) 付款：托管 -reward → 猎人 +reward（一对和为零的分录）。
  //    金额取文档自己的 reward —— 第 2 步就是按这个数扣的托管，两边必须是同一个数。
  const amount = Number(gated.reward || 0);
  await payEscrowToHunter({
    bountyId: id,
    hunterId: prevSub.hunter,
    amount,
    memo: "赏金审批通过，发放虚拟点数",
  });
  // 记下实际入账金额：之后 reward 再怎么改，这条提交显示的都是账本上的真值
  await BountySubmission.updateOne({ _id: sid }, { $set: { awardedPoints: amount } });

  // 4) 名额满 → completed，并把剩余托管结算掉（正常情况剩 0，这一步主要是把 refundedAt 封口，
  //    让悬赏进入终态：不会再有审批，也不会再有第二次退款）。
  if (Number(gated.approvedCount) >= Number(gated.slots)) {
    await Bounty.updateOne({ _id: id, status: { $ne: "completed" } }, { $set: { status: "completed" } });
    await settleBountyEscrow(id, "名额已满，结算剩余托管点数");
  }

  return respondWithSubmission(res, sid);
}

// ★approved 是终态：不允许 approved → rejected（点数已经入了猎人的账，撤不回来）。
//  既有实现允许倒回去并把 approvedCount 减 1、把 completed 退回 open；现在不再允许，
//  理由见文件头。前端本来就只在 status==="pending" 时显示通过/拒绝按钮，UI 上够不到这条路径。
async function rejectSubmission(res, id, sid) {
  const rejected = await BountySubmission.findOneAndUpdate(
    { _id: sid, bounty: id, status: { $ne: "approved" } },
    { $set: { status: "rejected" } },
    { new: true }
  ).lean();

  if (!rejected) {
    const current = await BountySubmission.findById(sid).select("_id status").lean();
    if (!current) notFound("Submission not found");
    badRequest("该提交已审批通过并发放了点数，不能再改为拒绝");
  }

  return respondWithSubmission(res, sid);
}

async function reviewSubmission(req, res, next) {
  try {
    const { id, sid } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");
    if (!isValidId(sid)) invalidId("Invalid submission id");

    const bounty = await Bounty.findById(id).select("author").lean();
    if (!bounty) notFound("Bounty not found");
    if (String(bounty.author) !== String(req.user._id)) forbidden("Forbidden");

    const exists = await BountySubmission.findOne({ _id: sid, bounty: id }).select("_id").lean();
    if (!exists) notFound("Submission not found");

    if (req.body.status === "rejected") return await rejectSubmission(res, id, sid);
    return await approveSubmission(res, id, sid);
  } catch (err) {
    next(err);
  }
}

async function listComments(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const bounty = await Bounty.findById(id).select("_id").lean();
    if (!bounty) notFound("Bounty not found");

    const { page, limit } = readPage(req);
    const filter = { bounty: id };
    const total = await BountyComment.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    // 升序（与情景/人格讨论区一致）。此处【不能】用倒序：楼中楼必然比它的顶楼更新，
    // 倒序分页会把回复排到比父级更靠前的页上 —— 首屏只拿到回复、父级还在后面的页里，
    // 那条回复就会以「顶楼」身份错位渲染，直到用户点「加载更多」才归位。
    // 升序则结构上保证「父级必先于其回复被加载」。
    // 唯一消费方是前端共用的 CommentThread（它本就按升序展示），故改序无回归。
    const items = await BountyComment.find(filter)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("author", "_id username")
      .lean();

    res.json({
      ok: true,
      comments: items.map(serializeComment),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

// parentId 校验：非法 id -> 400；父评论必须【属于同一 bounty】，
// 否则可以拿悬赏 A 的评论 id 当悬赏 B 的父级，把评论注入到别人的楼里。
// 只允许一层楼中楼：回复楼中楼时归到它所在的那个顶楼，不产生第三层。
async function resolveCommentParentId(rawParentId, bountyId) {
  if (rawParentId === undefined || rawParentId === null || String(rawParentId).trim() === "") {
    return null;
  }

  const parentId = String(rawParentId).trim();
  if (!isValidId(parentId)) invalidId("Invalid parent comment id");

  const parent = await BountyComment.findOne({ _id: parentId, bounty: bountyId })
    .select("_id parentId")
    .lean();
  if (!parent) notFound("Parent comment not found");

  return parent.parentId ? parent.parentId : parent._id;
}

async function addComment(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const bounty = await Bounty.findById(id).select("_id").lean();
    if (!bounty) notFound("Bounty not found");

    const parentId = await resolveCommentParentId(req.body.parentId, id);

    const doc = await BountyComment.create({
      bounty: id,
      author: req.user._id,
      text: String(req.body.text || "").trim().slice(0, 2000),
      imageUrl: normalizeSafeUrl(req.body.imageUrl),
      parentId,
    });
    await Bounty.updateOne({ _id: id }, { $inc: { "stats.commentCount": 1 } });

    const populated = await BountyComment.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, comment: serializeComment(populated) });
  } catch (err) {
    next(err);
  }
}

// 授权：仅评论作者本人 或 悬赏作者（版主）可删。
// 与情景/人格讨论区（arenaComment.controller.js remove）保持同一套规则。
async function removeComment(req, res, next) {
  try {
    const { id, commentId } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");
    if (!isValidId(commentId)) invalidId("Invalid comment id");

    const bounty = await Bounty.findById(id).select("_id author").lean();
    if (!bounty) notFound("Bounty not found");

    const comment = await BountyComment.findOne({ _id: commentId, bounty: id })
      .select("_id author parentId")
      .lean();
    if (!comment) notFound("Comment not found");

    const isCommentAuthor = String(comment.author) === String(req.user._id);
    if (!isCommentAuthor && !ownedBy(bounty, req.user)) forbidden("Forbidden");

    await BountyComment.deleteOne({ _id: commentId });
    // 删顶楼时级联删掉楼中楼，避免留下挂在不存在父级上的孤儿
    let cascaded = 0;
    if (!comment.parentId) {
      const r = await BountyComment.deleteMany({ bounty: id, parentId: commentId });
      cascaded = (r && r.deletedCount) || 0;
    }

    // 重新计数而非 $inc -n：级联删除条数不定，$inc 容易把 commentCount 减成负数
    const commentCount = await BountyComment.countDocuments({ bounty: id });
    await Bounty.updateOne({ _id: id }, { $set: { "stats.commentCount": commentCount } });

    // deleted = 实际删除总数（含级联）。前端按「已加载的回复数」自行推算会少减，
    // 导致 total 偏高、冒出「幽灵加载更多」。commentCount 是重算后的权威值，一并给回。
    res.json({ ok: true, deleted: 1 + cascaded, commentCount });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listBounties,
  listMyBounties,
  getBountyDetail,
  createBounty,
  updateBounty,
  removeBounty,
  setBountyStatus,
  listSubmissions,
  submitBounty,
  reviewSubmission,
  listComments,
  addComment,
  removeComment,
};
