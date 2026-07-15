// src/controllers/bounty.controller.js
// 赏金猎人（Bounty Hunter）控制器：悬赏任务的增删改查、提交/审批、讨论评论。
// 赏金 = 平台虚拟点数（reward:number），不是真钱，不做任何真实支付/转账。
// 审批通过即视为该猎人获得该点数（收入 = 已通过提交之和，不做钱包）。
const mongoose = require("mongoose");
const Bounty = require("../models/Bounty");
const BountySubmission = require("../models/BountySubmission");
const BountyComment = require("../models/BountyComment");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");

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

async function createBounty(req, res, next) {
  try {
    const doc = await Bounty.create({
      author: req.user._id,
      title: String(req.body.title || "").trim().slice(0, 120),
      description: String(req.body.description || "").trim().slice(0, 5000),
      reward: Number(req.body.reward || 0),
      platform: normalizePlatform(req.body.platform),
      targetUrl: normalizeSafeUrl(req.body.targetUrl),
      tags: toTags(req.body.tags),
      slots: Math.max(1, parseInt(req.body.slots, 10) || 1),
      deadline: parseDeadline(req.body.deadline),
    });

    const populated = await Bounty.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, bounty: toBountyPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function updateBounty(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id);
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.title !== undefined) doc.title = String(req.body.title || "").trim().slice(0, 120);
    if (req.body.description !== undefined) doc.description = String(req.body.description || "").trim().slice(0, 5000);
    if (req.body.reward !== undefined) doc.reward = Number(req.body.reward || 0);
    if (req.body.platform !== undefined) doc.platform = normalizePlatform(req.body.platform);
    if (req.body.targetUrl !== undefined) doc.targetUrl = normalizeSafeUrl(req.body.targetUrl);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.slots !== undefined) doc.slots = Math.max(1, parseInt(req.body.slots, 10) || 1);
    if (req.body.deadline !== undefined) doc.deadline = parseDeadline(req.body.deadline);

    await doc.save();
    const populated = await Bounty.findById(doc._id).populate("author", "_id username").lean();
    res.json({ ok: true, bounty: toBountyPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function removeBounty(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id);
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

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

async function setBountyStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const doc = await Bounty.findById(id);
    if (!doc) notFound("Bounty not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    doc.status = req.body.status;
    await doc.save();

    const populated = await Bounty.findById(doc._id).populate("author", "_id username").lean();
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

async function reviewSubmission(req, res, next) {
  try {
    const { id, sid } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");
    if (!isValidId(sid)) invalidId("Invalid submission id");

    const bounty = await Bounty.findById(id);
    if (!bounty) notFound("Bounty not found");
    if (String(bounty.author) !== String(req.user._id)) forbidden("Forbidden");

    const submission = await BountySubmission.findOne({ _id: sid, bounty: id });
    if (!submission) notFound("Submission not found");

    const nextStatus = req.body.status;
    const prev = submission.status;
    const slots = Number(bounty.slots || 1);

    // 名额闸门：已满则不允许再通过（防止超额审批 / 超名额猎人重复领赏）
    if (nextStatus === "approved" && prev !== "approved" && Number(bounty.approvedCount || 0) >= slots) {
      badRequest("Bounty already fully approved");
    }

    submission.status = nextStatus;
    await submission.save();

    if (nextStatus === "approved" && prev !== "approved") {
      bounty.approvedCount = Number(bounty.approvedCount || 0) + 1;
    } else if (nextStatus === "rejected" && prev === "approved") {
      bounty.approvedCount = Math.max(0, Number(bounty.approvedCount || 0) - 1);
    }
    // 名额满 → completed；名额重新空出 → 从 completed 退回 open（可逆，避免状态与计数矛盾）
    if (Number(bounty.approvedCount || 0) >= slots) {
      if (bounty.status !== "completed") bounty.status = "completed";
    } else if (bounty.status === "completed") {
      bounty.status = "open";
    }
    await bounty.save();

    const populated = await BountySubmission.findById(submission._id).populate("hunter", "_id username").lean();
    res.json({ ok: true, submission: serializeSubmission(populated) });
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

    const items = await BountyComment.find(filter)
      .sort({ createdAt: -1 })
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

async function addComment(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid bounty id");

    const bounty = await Bounty.findById(id).select("_id").lean();
    if (!bounty) notFound("Bounty not found");

    const doc = await BountyComment.create({
      bounty: id,
      author: req.user._id,
      text: String(req.body.text || "").trim().slice(0, 2000),
      imageUrl: normalizeSafeUrl(req.body.imageUrl),
    });
    await Bounty.updateOne({ _id: id }, { $inc: { "stats.commentCount": 1 } });

    const populated = await BountyComment.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, comment: serializeComment(populated) });
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
};
