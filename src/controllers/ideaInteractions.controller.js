const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Comment = require("../models/Comment");
const Notification = require("../models/Notification");
const { createNotification } = require("../services/notification.service");
const { canReadIdea, canInteractIdea } = require("../utils/permissions");
const { invalidId, notFound, unauthorized, forbidden } = require("../utils/http");
const { parseMentions } = require("../utils/mentionParser");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

async function getIdeaOr404(id, req, res) {
  if (!isValidId(id)) {
    invalidId("Invalid idea id");
  }
  const idea = await Idea.findById(id);
  if (!idea) {
    notFound("Idea not found");
  }
  if (!canReadIdea(idea, req.user)) {
    if (!req.user) {
      unauthorized("Login required")
    }
    forbidden("Forbidden");
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

    const idea = await getIdeaOr404(id, req, res);

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

    if (liked) {
      await createNotification({
        userId: idea.author,     // 你的 idea 作者字段在 interest.controller 里用的是 idea.author
        actorId: userId,
        ideaId: idea._id,
        type: "LIKE",
        payload: {},
      });
    }

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

    const idea = await getIdeaOr404(id, req, res);

    const existing = await Bookmark.findOne({ user: userId, idea: idea._id, type: "idea" });
    let bookmarked;

    if (existing) {
      await Bookmark.deleteOne({ _id: existing._id });
      bookmarked = false;
      idea.stats.bookmarkCount = Math.max((idea.stats.bookmarkCount || 0) - 1, 0);
    } else {
      await Bookmark.create({ user: userId, idea: idea._id, type: "idea" });
      bookmarked = true;
      idea.stats.bookmarkCount = (idea.stats.bookmarkCount || 0) + 1;
    }

    await idea.save();

    if (bookmarked) {
      await createNotification({
        userId: idea.author,
        actorId: userId,
        ideaId: idea._id,
        type: "BOOKMARK",
        payload: {},
      });
    }

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
    const idea = await getIdeaOr404(id, req, res);

    const comments = await Comment.find({ idea: idea._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("author", "_id username role")
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

    const idea = await getIdeaOr404(id, req, res);

    // Parse mentions in comment content
    const { userIds: mentionedUserIds } = await parseMentions(content);

    const comment = await Comment.create({
      idea: idea._id,
      author: req.user._id,
      content: String(content).trim(),
      mentions: mentionedUserIds,
    });

    idea.stats.commentCount = (idea.stats.commentCount || 0) + 1;
    await idea.save();

    const populated = await Comment.findById(comment._id).populate("author", "_id username role");

    await createNotification({
      userId: idea.author,
      actorId: req.user._id,
      ideaId: idea._id,
      type: "COMMENT",
      payload: { commentId: comment._id },
    });

    // Create MENTION notifications for mentioned users (excluding the idea author if already notified)
    if (mentionedUserIds.length > 0) {
      const notifs = mentionedUserIds.map(userId => ({
        userId,
        actorId: req.user._id,
        ideaId: idea._id,
        type: "MENTION",
        payload: { commentId: comment._id, content: comment.content },
      }));
      await Notification.insertMany(notifs);
    }

    res.status(201).json({ ok: true, comment: populated, commentCount: idea.stats.commentCount });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/ideas/:id/comments/:commentId/like
 * Toggle like on a comment
 */
async function likeComment(req, res, next) {
  try {
    const { id, commentId } = req.params;
    const userId = req.user._id;

    console.log(`[likeComment] userId=${userId}, commentId=${commentId}, ideaId=${id}`);

    const idea = await getIdeaOr404(id, req, res);
    
    const comment = await Comment.findOne({ _id: commentId, idea: idea._id });
    console.log(`[likeComment] Found comment:`, { _id: comment?._id, author: comment?.author, content: comment?.content?.substring(0, 20) });

    if (!comment) {
      return res.status(404).json({ ok: false, message: "Comment not found" });
    }

    const uid = String(userId);
    const idx = comment.likes.findIndex(u => String(u) === uid);
    let liked = false;

    if (idx >= 0) {
      // unlike
      comment.likes.splice(idx, 1);
      comment.likesCount = Math.max(0, comment.likesCount - 1);
      liked = false;
    } else {
      // like
      comment.likes.push(userId);
      comment.likesCount = (comment.likesCount || 0) + 1;
      liked = true;
    }

    await comment.save();
    console.log(`[likeComment] Saved comment, liked=${liked}, likesCount=${comment.likesCount}`);

    // Create LIKE notification for comment author if not self
    if (liked && String(comment.author) !== uid) {
      console.log(`[likeComment] Creating notification for author=${comment.author}`);
      await createNotification({
        userId: comment.author,
        actorId: userId,
        ideaId: idea._id,
        type: "LIKE_COMMENT",
        payload: { commentId: comment._id },
      });
    } else {
      console.log(`[likeComment] Skipped notification: liked=${liked}, authorEqualsUser=${String(comment.author) === uid}`);
    }

    res.json({ ok: true, liked, likesCount: comment.likesCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { toggleLike, toggleBookmark, listComments, addComment, likeComment };
