const LeaderboardPost = require("../models/LeaderboardPost");
const Idea = require("../models/Idea");
const { invalidId, unauthorized } = require("../utils/http");
const { createNotification } = require("../services/notification.service");
const mongoose = require("mongoose");

async function createPost(req, res, next) {
  try {
    if (!req.user) return unauthorized("Login required");
    const { title, body, tagsKey } = req.body;
    if (!tagsKey) return invalidId("tagsKey required");
    if (!title || !body) return invalidId("title and body required");
    const post = await LeaderboardPost.create({ title, body, tagsKey, author: req.user._id });
    const populated = await LeaderboardPost.findById(post._id).populate("author", "username role").lean();
    res.json({ ok: true, post: populated });
  } catch (err) {
    next(err);
  }
}

async function listPosts(req, res, next) {
  try {
    const tagsKey = (req.query.tagsKey || req.query.tags || "").toString();
    const sort = (req.query.sort || "popular").toString();
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
    const q = { tagsKey };
    const skip = (page - 1) * limit;
    let sortObj = { likesCount: -1, createdAt: -1 };
    if (sort === "recent") sortObj = { createdAt: -1 };
    const posts = await LeaderboardPost.find(q).sort(sortObj).skip(skip).limit(limit).populate("author", "username role").lean();
    const total = await LeaderboardPost.countDocuments(q);
    res.json({ ok: true, posts, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function likePost(req, res, next) {
  try {
    if (!req.user) return unauthorized("Login required");
    const id = req.params.id;
    if (!id || !mongoose.isValidObjectId(id)) return invalidId("Invalid post id");
    const post = await LeaderboardPost.findById(id);
    if (!post) return invalidId("Post not found");
    const uid = String(req.user._id);
    const idx = post.likes.findIndex(u => String(u) === uid);
    let liked = false;
    if (idx >= 0) {
      // unlike
      post.likes.splice(idx, 1);
      post.likesCount = Math.max(0, post.likesCount - 1);
      liked = false;
    } else {
      post.likes.push(req.user._id);
      post.likesCount = (post.likesCount || 0) + 1;
      liked = true;
      // Create notification when liking
      await createNotification({
        userId: post.author,
        actorId: req.user._id,
        ideaId: null,
        type: "LIKE_POST",
        payload: { postId: post._id, postTitle: post.title },
      });
    }
    await post.save();
    res.json({ ok: true, liked, likesCount: post.likesCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { createPost, listPosts, likePost };
