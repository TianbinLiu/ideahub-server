const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");

require("../models/User"); // 确保 populate(User) 不报错

function toStringArray(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String).map(s => s.trim()).filter(Boolean);
  return String(tags)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function isOwner(idea, user) {
  return idea.author.toString() === user._id.toString();
}

/**
 * POST /api/ideas
 * 需要登录：req.user
 * body: title, summary, content, tags, visibility, isMonetizable, licenseType
 */
async function createIdea(req, res, next) {
  try {
    const { title, summary, content, visibility, isMonetizable, licenseType, tags } = req.body;

    if (!title || !title.trim()) {
      res.status(400);
      throw new Error("title is required");
    }

    const idea = await Idea.create({
      title: title.trim(),
      summary: summary || "",
      content: content || "",
      author: req.user._id,
      tags: toStringArray(tags),
      visibility: visibility || "public",
      isMonetizable: Boolean(isMonetizable),
      licenseType: licenseType || "default",
    });

    const populated = await Idea.findById(idea._id).populate("author", "username role");
    res.status(201).json({ ok: true, idea: populated });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ideas?page=1&limit=20&sort=new|hot
 * Phase 3：列表只返回 public（unlisted/private 不出现在列表）
 * sort:
 *  - new: createdAt desc
 *  - hot: stats.likeCount desc, then createdAt desc（先简化）
 */
async function listIdeas(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);

    const sort = String(req.query.sort || "new");
    const sortSpec =
      sort === "hot"
        ? { "stats.likeCount": -1, createdAt: -1 }
        : { createdAt: -1 };

    const tag = (req.query.tag || "").toString().trim();
    const keyword = (req.query.keyword || "").toString().trim();

    // 列表：只返回 public
    const filter = { visibility: "public" };

    if (tag) {
      // tags 是字符串数组，直接匹配
      filter.tags = tag;
    }

    if (keyword) {
      // 简单版：title/summary/content 模糊匹配（不做全文索引）
      const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: re }, { summary: re }, { content: re }];
    }

    const [items, total] = await Promise.all([
      Idea.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "username role")
        .lean(),
      Idea.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages,
      ideas: items,
    });
  } catch (err) {
    next(err);
  }
}


/**
 * GET /api/ideas/:id
 * 可见性规则：
 *  - public: anyone
 *  - unlisted: anyone with id
 *  - private: only author (must be logged in)
 * 额外：访问一次 viewCount + 1
 */
async function getIdeaById(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid idea id");
    }

    const idea = await Idea.findById(id).populate("author", "username role");
    if (!idea) {
      res.status(404);
      throw new Error("Idea not found");
    }

    // 权限判断
    if (idea.visibility === "private") {
      // 必须登录且是作者
      if (!req.user) {
        res.status(401);
        throw new Error("Login required");
      }
      if (!isOwner(idea, req.user)) {
        res.status(403);
        throw new Error("Forbidden");
      }
    }

    // viewCount + 1（不阻塞返回也行，但这里简单同步做）
    idea.stats = idea.stats || {};
    idea.stats.viewCount = (idea.stats.viewCount || 0) + 1;
    await idea.save();

    let liked = false;
    let bookmarked = false;

    if (req.user) {
      const [l, b] = await Promise.all([
        Like.findOne({ user: req.user._id, idea: idea._id }).lean(),
        Bookmark.findOne({ user: req.user._id, idea: idea._id }).lean(),
      ]);
      liked = !!l;
      bookmarked = !!b;
    }

    res.json({ ok: true, idea, liked, bookmarked });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/ideas/:id
 * 仅作者可改
 * 允许更新：title, summary, content, tags, visibility, isMonetizable, licenseType
 */
async function updateIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid idea id");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      res.status(404);
      throw new Error("Idea not found");
    }

    if (!isOwner(idea, req.user)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const { title, summary, content, tags, visibility, isMonetizable, licenseType } = req.body;

    if (title !== undefined) {
      if (!String(title).trim()) {
        res.status(400);
        throw new Error("title cannot be empty");
      }
      idea.title = String(title).trim();
    }
    if (summary !== undefined) idea.summary = String(summary);
    if (content !== undefined) idea.content = String(content);
    if (tags !== undefined) idea.tags = toStringArray(tags);
    if (visibility !== undefined) idea.visibility = visibility;
    if (isMonetizable !== undefined) idea.isMonetizable = Boolean(isMonetizable);
    if (licenseType !== undefined) idea.licenseType = String(licenseType);

    await idea.save();

    const populated = await Idea.findById(id).populate("author", "username role");
    res.json({ ok: true, idea: populated });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/ideas/:id
 * 仅作者可删
 */
async function deleteIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      res.status(400);
      throw new Error("Invalid idea id");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      res.status(404);
      throw new Error("Idea not found");
    }

    if (!isOwner(idea, req.user)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    await Idea.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function listMyIdeas(req, res, next) {
  try {
    const items = await Idea.find({ author: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("author", "username role");
    res.json({ ok: true, ideas: items });
  } catch (err) {
    next(err);
  }
}


module.exports = { createIdea, listIdeas, getIdeaById, updateIdea, deleteIdea, listMyIdeas };
