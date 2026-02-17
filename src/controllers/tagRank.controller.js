const Idea = require("../models/Idea");
const TagVote = require("../models/TagVote");
const mongoose = require("mongoose");
const { invalidId, unauthorized } = require("../utils/http");

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String).map(s => s.trim()).filter(Boolean).map(s=>s.toLowerCase()).sort();
  return String(tags).split(",").map(s => s.trim()).filter(Boolean).map(s=>s.toLowerCase()).sort();
}

async function getRank(req, res, next) {
  try {
    const tags = normalizeTags(req.query.tags || req.query.tag || []);
    const tagsKey = tags.join("|");

    // aggregate TagVote to compute score per idea for this tag combo
    const agg = await TagVote.aggregate([
      { $match: { tagsKey } },
      { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
      { $sort: { score: -1 } },
      { $limit: 200 },
    ]);

    const ideaIds = agg.map((a) => a._id);
    const ideas = await Idea.find({ _id: { $in: ideaIds } }).populate("author", "username role").lean();

    // map ideas with scores preserving order
    const ideaMap = Object.fromEntries(ideas.map((i) => [String(i._id), i]));
    const results = agg.map((a) => ({ idea: ideaMap[String(a._id)] || null, score: a.score, votes: a.votes })).filter(r=>r.idea);

    res.json({ ok: true, tags, tagKey: tagsKey, results });
  } catch (err) {
    next(err);
  }
}

async function vote(req, res, next) {
  try {
    if (!req.user) {
      return unauthorized("Login required");
    }

    const { ideaId, tags, vote } = req.body;
    if (!ideaId || !mongoose.isValidObjectId(ideaId)) invalidId("Invalid idea id");
    const v = Number(vote) === 1 ? 1 : -1;

    const normalized = normalizeTags(tags);
    const tagsKey = normalized.join("|");

    // upsert vote document (if exists and same vote -> remove, otherwise set)
    const existing = await TagVote.findOne({ idea: ideaId, tagsKey, user: req.user._id });
    if (existing) {
      if (existing.vote === v) {
        // unvote
        await TagVote.deleteOne({ _id: existing._id });
      } else {
        existing.vote = v;
        await existing.save();
      }
    } else {
      await TagVote.create({ idea: ideaId, tags: normalized, tagsKey, user: req.user._id, vote: v });
    }

    // return updated score
    const agg = await TagVote.aggregate([
      { $match: { idea: mongoose.Types.ObjectId(ideaId), tagsKey } },
      { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
    ]);
    const score = agg[0]?.score || 0;
    const votesCount = agg[0]?.votes || 0;

    res.json({ ok: true, ideaId, tags: normalized, tagsKey, score, votes: votesCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRank, vote };
