const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const { canReadIdea, canWriteIdea } = require("../utils/permissions");
const { invalidId, notFound, unauthorized, forbidden } = require("../utils/http");


require("../models/User"); // 确保 populate(User) 不报错
// IdeaView 用于记录用户对某个 idea 的最后浏览时间（用于每天只计一次 view）
const IdeaView = require("../models/IdeaView");

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

/**
 * POST /api/ideas
 * 需要登录：req.user
 * body: title, summary, content, tags, visibility, isMonetizable, licenseType
 */
async function createIdea(req, res, next) {
  try {
    const { title, summary, content, visibility, isMonetizable, licenseType, tags } = req.body;

    if (!title || !title.trim()) {
      invalidId("Invalid idea id")
    }

    // Enforce: clients should not create server-side private ideas — private ideas are stored locally in browser.
    if (visibility === "private") {
      // tell client to save locally instead of creating on server
      return res.status(400).json({ ok: false, code: "PRIVATE_SAVE_LOCAL", message: "Private ideas should be saved locally in browser." });
    }

    // Enforce public idea limit for free users
    const PUBLIC_LIMIT = Number(process.env.FREE_PUBLIC_IDEA_LIMIT || 5);
    if ((visibility || "public") === "public" && req.user) {
      const role = (req.user && req.user.role) || "user";
      if (role !== "company" && role !== "admin") {
        const count = await Idea.countDocuments({ author: req.user._id, visibility: "public" });
        if (count >= PUBLIC_LIMIT) {
          const { publicLimitExceeded } = require("../utils/http");
          return next(new (require("../utils/AppError"))({ code: require("../utils/errorCodes").PUBLIC_LIMIT_EXCEEDED, status: 403, message: `Free accounts can publish up to ${PUBLIC_LIMIT} public ideas.`, details: { limit: PUBLIC_LIMIT } }));
        }
      }
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

    const q = (req.query.q || req.query.keyword || req.query.tag || "").toString().trim();

    // 列表：只返回 public
    const filter = { visibility: "public" };

    if (q) {
      // If q contains commas or spaces, treat as tag combination
      if (q.includes(",") || q.includes(" ")) {
        const tags = q.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
        if (tags.length === 1) {
          filter.tags = tags[0];
        } else if (tags.length > 1) {
          filter.tags = { $all: tags };
        }
      } else {
        // single token: match either tag or text
        const re = new RegExp(q.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "i");
        filter.$or = [{ title: re }, { summary: re }, { content: re }, { tags: q }];
      }
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
      invalidId("Invalid idea id")
    }

    const idea = await Idea.findById(id).populate("author", "username role");
    if (!idea) {
      notFound("Idea not found")
    }

    // 权限判断
    if (!canReadIdea(idea, req.user)) {
      // private 且未登录 → 401 更合理；private 且登录但不是作者 → 403
      if (!req.user) {
        unauthorized("Login required")
      }
      forbidden("Forbidden")
    }


    // 只有已登录用户会计入 view；且同一用户在 24 小时内仅计一次
    if (req.user) {
      try {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const now = new Date();

        const existing = await IdeaView.findOne({ user: req.user._id, idea: idea._id });
        if (!existing) {
          // 首次浏览：创建记录并 +1
          await IdeaView.create({ user: req.user._id, idea: idea._id, lastViewedAt: now });
          idea.stats = idea.stats || {};
          idea.stats.viewCount = (idea.stats.viewCount || 0) + 1;
          await idea.save();
        } else {
          const last = existing.lastViewedAt || existing.createdAt || new Date(0);
          if (now.getTime() - new Date(last).getTime() >= DAY_MS) {
            existing.lastViewedAt = now;
            await existing.save();
            idea.stats = idea.stats || {};
            idea.stats.viewCount = (idea.stats.viewCount || 0) + 1;
            await idea.save();
          }
        }
      } catch (e) {
        // 任何计数错误不应阻塞返回（例如并发或索引冲突），只打印日志
        console.error("view count update failed:", e?.message || e);
      }
    }

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
      invalidId("Invalid idea id")
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found")
    }

    if (!canWriteIdea(idea, req.user)) {
      forbidden("Forbidden")
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
      badRequest("title is required");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found");
    }

    if (!canWriteIdea(idea, req.user)) {
      forbidden("Forbidden")
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




// suggestion endpoint for idea titles (used by client autocomplete)
async function suggestTitles(req, res, next) {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ ok: true, ideas: [] });
    const re = new RegExp(q.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "i");
    const items = await Idea.find({ visibility: "public", title: re })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("title")
      .lean();
    res.json({ ok: true, ideas: items.map(i => ({ id: i._id, title: i.title })) });
  } catch (err) {
    next(err);
  }
}

module.exports = { createIdea, listIdeas, getIdeaById, updateIdea, deleteIdea, listMyIdeas, suggestTitles };
