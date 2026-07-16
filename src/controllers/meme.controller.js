// src/controllers/meme.controller.js
// 表情/梗图库（Meme）控制器：素材库/我的收藏列表、详情、增删改（owner 校验）、
// 收藏/取消收藏（collect/uncollect，collectCount 重算）、使用计数（use，$inc useCount）。
const mongoose = require("mongoose");
const Meme = require("../models/Meme");
const MemeCollect = require("../models/MemeCollect");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
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

// ── 序列化（严格对齐冻结契约 Meme）─────────────────────────────
function toMemePayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: doc.author && typeof doc.author === "object"
      ? { _id: doc.author._id, username: doc.author.username }
      : (doc.author || null),
    type: doc.type,
    imageUrl: doc.imageUrl || "",
    text: doc.text || "",
    title: doc.title || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    shared: !!doc.shared,
    stats: {
      collectCount: Number(doc?.stats?.collectCount || 0),
      useCount: Number(doc?.stats?.useCount || 0),
    },
    collected: !!ctx.collected,
    isOwner: !!ctx.isOwner,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function ownedBy(doc, user) {
  return !!user && !!doc.author && String(user._id) === String(doc.author?._id || doc.author);
}

async function loadCollectedSet(user, docs) {
  if (!user || !docs.length) return new Set();
  const ids = docs.map((d) => d._id);
  const collects = await MemeCollect.find({ user: user._id, meme: { $in: ids } }).select("meme").lean();
  return new Set(collects.map((x) => String(x.meme)));
}

// ── list ─────────────────────────────────────────────────────────

async function listMemes(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "24", 10) || 24, 1), 60);
    const sort = String(req.query.sort || "new").toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const tag = String(req.query.tag || "").trim().toLowerCase();

    let scope = String(req.query.scope || "library").toLowerCase();
    if (!["library", "mine"].includes(scope)) scope = "library";
    // mine 需登录，未登录返回空
    if (scope === "mine" && !req.user) {
      return res.json({ ok: true, memes: [], total: 0, page, limit, totalPages: 1 });
    }

    let filter;
    if (scope === "mine") {
      const collects = await MemeCollect.find({ user: req.user._id }).select("meme").lean();
      filter = { _id: { $in: collects.map((x) => x.meme) } };
    } else {
      filter = { shared: true };
    }
    if (tag) filter.tags = tag;

    let items = await Meme.find(filter).populate("author", "_id username").lean();

    if (q) {
      items = items.filter((item) => {
        const hay = `${item.title || ""} ${item.text || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (sort === "hot") {
      items.sort((a, b) => {
        const ha = Number(a?.stats?.collectCount || 0);
        const hb = Number(b?.stats?.collectCount || 0);
        if (hb !== ha) return hb - ha;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else {
      items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    }

    const total = items.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const paged = items.slice((page - 1) * limit, page * limit);

    const collectedSet = await loadCollectedSet(req.user, paged);

    res.json({
      ok: true,
      memes: paged.map((item) => toMemePayload(item, {
        collected: collectedSet.has(String(item._id)),
        isOwner: ownedBy(item, req.user),
      })),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function getMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const existing = await Meme.findById(id).populate("author", "_id username").lean();
    if (!existing) notFound("Meme not found");

    let collected = false;
    if (req.user) {
      collected = !!(await MemeCollect.exists({ user: req.user._id, meme: id }));
    }

    res.json({
      ok: true,
      meme: toMemePayload(existing, { collected, isOwner: ownedBy(existing, req.user) }),
    });
  } catch (err) {
    next(err);
  }
}

async function createMeme(req, res, next) {
  try {
    const type = req.body.type;
    const imageUrl = String(req.body.imageUrl || "").trim();
    const text = String(req.body.text || "").trim();
    if (type === "image" && !imageUrl) badRequest("imageUrl is required for image meme");
    if (type === "text" && !text) badRequest("text is required for text meme");

    const doc = await Meme.create({
      author: req.user._id,
      type,
      imageUrl: imageUrl.slice(0, 2000),
      text: text.slice(0, 2000),
      title: String(req.body.title || "").trim().slice(0, 120),
      tags: toTags(req.body.tags),
      shared: Boolean(req.body.shared),
    });

    // 创建即自动收藏给作者
    await MemeCollect.create({ user: req.user._id, meme: doc._id });
    const collectCount = await MemeCollect.countDocuments({ meme: doc._id });
    await Meme.updateOne({ _id: doc._id }, { $set: { "stats.collectCount": collectCount } });

    const populated = await Meme.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, meme: toMemePayload(populated, { collected: true, isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function updateMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const doc = await Meme.findById(id);
    if (!doc) notFound("Meme not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.type !== undefined) doc.type = req.body.type;
    if (req.body.imageUrl !== undefined) doc.imageUrl = String(req.body.imageUrl || "").trim().slice(0, 2000);
    if (req.body.text !== undefined) doc.text = String(req.body.text || "").trim().slice(0, 2000);
    if (req.body.title !== undefined) doc.title = String(req.body.title || "").trim().slice(0, 120);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.shared !== undefined) doc.shared = Boolean(req.body.shared);

    // 保证 type 与内容一致
    if (doc.type === "image" && !doc.imageUrl) badRequest("imageUrl is required for image meme");
    if (doc.type === "text" && !doc.text) badRequest("text is required for text meme");

    await doc.save();

    const collected = !!(await MemeCollect.exists({ user: req.user._id, meme: id }));
    const populated = await Meme.findById(doc._id).populate("author", "_id username").lean();
    res.json({ ok: true, meme: toMemePayload(populated, { collected, isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function removeMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const doc = await Meme.findById(id);
    if (!doc) notFound("Meme not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      Meme.deleteOne({ _id: id }),
      MemeCollect.deleteMany({ meme: id }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function collectMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const meme = await Meme.findById(id).select("_id").lean();
    if (!meme) notFound("Meme not found");

    // 幂等：已收藏则不重复计数
    await MemeCollect.updateOne(
      { user: req.user._id, meme: id },
      { $setOnInsert: { user: req.user._id, meme: id } },
      { upsert: true }
    );

    const collectCount = await MemeCollect.countDocuments({ meme: id });
    await Meme.updateOne({ _id: id }, { $set: { "stats.collectCount": collectCount } });

    res.json({ ok: true, collected: true, collectCount });
  } catch (err) {
    next(err);
  }
}

async function uncollectMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const meme = await Meme.findById(id).select("_id").lean();
    if (!meme) notFound("Meme not found");

    await MemeCollect.deleteOne({ user: req.user._id, meme: id });

    const collectCount = await MemeCollect.countDocuments({ meme: id });
    await Meme.updateOne({ _id: id }, { $set: { "stats.collectCount": collectCount } });

    res.json({ ok: true, collected: false, collectCount });
  } catch (err) {
    next(err);
  }
}

async function useMeme(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid meme id");

    const meme = await Meme.findById(id).select("_id").lean();
    if (!meme) notFound("Meme not found");

    await Meme.updateOne({ _id: id }, { $inc: { "stats.useCount": 1 } });
    const refreshed = await Meme.findById(id).select("stats").lean();

    res.json({ ok: true, useCount: Number(refreshed?.stats?.useCount || 0) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMemes,
  getMeme,
  createMeme,
  updateMeme,
  removeMeme,
  collectMeme,
  uncollectMeme,
  useMeme,
};
