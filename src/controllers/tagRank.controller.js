const Idea = require("../models/Idea");
const TagVote = require("../models/TagVote");
const mongoose = require("mongoose");
const { invalidId, unauthorized, forbidden } = require("../utils/http");

// simple in-memory cache for leaderboards
const CACHE = new Map(); // key -> { expires: Date, value }
const CACHE_TTL = Number(process.env.TAG_RANK_CACHE_TTL_SECONDS) || 30;

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String).map(s => s.trim()).filter(Boolean).map(s=>s.toLowerCase()).sort();
  return String(tags).split(",").map(s => s.trim()).filter(Boolean).map(s=>s.toLowerCase()).sort();
}

async function getRank(req, res, next) {
  try {
    const tags = normalizeTags(req.query.tags || req.query.tag || []);
    const tagsKey = tags.join("|");

    // check cache
    const cached = CACHE.get(tagsKey);
    if (cached && cached.expires > Date.now()) {
      return res.json({ ok: true, tags, tagKey: tagsKey, results: cached.value });
    }

    // aggregate TagVote to compute score per idea for this tag combo
    let agg;
    if (!tagsKey) {
      agg = await TagVote.aggregate([
        { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
        { $sort: { score: -1 } },
        { $limit: 200 },
      ]);
    } else {
      agg = await TagVote.aggregate([
        { $match: { tagsKey } },
        { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
        { $sort: { score: -1 } },
        { $limit: 200 },
      ]);
    }

    const ideaIds = agg.map((a) => a._id);
    const ideas = await Idea.find({ _id: { $in: ideaIds } }).populate("author", "username role").lean();

    // map ideas with scores preserving order
    const ideaMap = Object.fromEntries(ideas.map((i) => [String(i._id), i]));
    const results = agg.map((a) => ({ idea: ideaMap[String(a._id)] || null, score: a.score, votes: a.votes })).filter(r=>r.idea);

    // store cache
    CACHE.set(tagsKey, { expires: Date.now() + CACHE_TTL * 1000, value: results });
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
      // ensure idea exists and is public
      const idea = await Idea.findById(ideaId).lean();
      if (!idea) return invalidId("Idea not found");
      if (idea.visibility !== "public") {
        return forbidden("Voting is allowed only on public ideas");
      }

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

    // invalidate cache for this tagKey
    CACHE.delete(tagsKey);

    res.json({ ok: true, ideaId, tags: normalized, tagsKey, score, votes: votesCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRank, vote };
// tag suggestions: find popular tags starting with q
async function suggestTags(req, res, next) {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json({ ok: true, tags: [] });

    const agg = await Idea.aggregate([
      { $unwind: "$tags" },
      { $project: { tag: { $toLower: "$tags" } } },
      { $match: { tag: { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } } },
      { $group: { _id: "$tag", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    res.json({ ok: true, tags: agg.map(a => a._id) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRank, vote, suggestTags };
