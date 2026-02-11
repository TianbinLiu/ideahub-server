const mongoose = require("mongoose");
const Idea = require("../models/Idea");
const { generateIdeaReview } = require("../services/aiReview.service");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function isOwner(idea, user) {
  return idea.author.toString() === user._id.toString();
}

async function requestAiReview(req, res, next) {
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

    // ✅ 仅作者可调用（建议 Phase 7 这样做最安全）
    if (!isOwner(idea, req.user)) {
      res.status(403);
      throw new Error("Forbidden");
    }

    const review = await generateIdeaReview({
      title: idea.title,
      summary: idea.summary,
      content: idea.content,
      tags: idea.tags,
    });

    idea.aiReview = review;
    await idea.save();

    res.json({ ok: true, aiReview: idea.aiReview });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestAiReview };
