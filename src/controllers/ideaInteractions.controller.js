const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Comment = require("../models/Comment");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function getIdeaOr404(id, res) {
  if (!isValidId(id)) {
    res.status(400);
    throw new Error("Invalid idea id");
  }
  const idea = await Idea.findById(id);
  if (!idea) {
    res.status(404);
    throw new Error("Idea not found");
  }
  return idea;
}

/**
 * POST /api/ideas/:id/like
 * 切换点赞：存在则删除，不存在则创建
 * 同步更新 idea.stats.likeCount
 */
async function toggleLike(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const idea = await getIdeaOr404(id, res);

    const existing = await Like.findOne({ user: userId, idea: idea._id });
    let liked;

    if (existing) {
      await Like.deleteOne({ _id: existing._id });
      liked = false;
      idea.stats.likeCount = Math.max((idea.stats.likeCount || 0) - 1, 0);
    } else {
      await Like.create({ user: userId, idea: idea._id });
      liked = true;
      idea.stats.likeCount = (idea.stats.likeCount || 0) + 1;
    }

    await idea.save();
    res.json({ ok: true, liked, likeCount: idea.stats.likeCount });
  } catch (err) {
    // 唯一索引并发下可能抛 duplicate key → 当成 liked=true
    if (err?.code === 11000) return res.json({ ok: true, liked: true });
    next(err);
  }
}

/**
 * POST /api/ideas/:id/bookmark
 */
async function toggleBookmark(req, res, next) {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const idea = await getIdeaOr404(id, res);

    const existing = await Bookmark.findOne({ user: userId, idea: idea._id });
    let bookmarked;

    if (existing) {
      await Bookmark.deleteOne({ _id: existing._id });
      bookmarked = false;
      idea.stats.bookmarkCount = Math.max((idea.stats.bookmarkCount || 0) - 1, 0);
    } else {
      await Bookmark.create({ user: userId, idea: idea._id });
      bookmarked = true;
      idea.stats.bookmarkCount = (idea.stats.bookmarkCount || 0) + 1;
    }

    await idea.save();
    res.json({ ok: true, bookmarked, bookmarkCount: idea.stats.bookmarkCount });
  } catch (err) {
    if (err?.code === 11000) return res.json({ ok: true, bookmarked: true });
    next(err);
  }
}

/**
 * GET /api/ideas/:id/comments
 */
async function listComments(req, res, next) {
  try {
    const { id } = req.params;
    const idea = await getIdeaOr404(id, res);

    const comments = await Comment.find({ idea: idea._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("author", "username role")
      .lean();

    res.json({ ok: true, comments });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/ideas/:id/comments
 */
async function addComment(req, res, next) {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !String(content).trim()) {
      res.status(400);
      throw new Error("content is required");
    }

    const idea = await getIdeaOr404(id, res);

    const comment = await Comment.create({
      idea: idea._id,
      author: req.user._id,
      content: String(content).trim(),
    });

    idea.stats.commentCount = (idea.stats.commentCount || 0) + 1;
    await idea.save();

    const populated = await Comment.findById(comment._id).populate("author", "username role");
    res.status(201).json({ ok: true, comment: populated, commentCount: idea.stats.commentCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { toggleLike, toggleBookmark, listComments, addComment };
