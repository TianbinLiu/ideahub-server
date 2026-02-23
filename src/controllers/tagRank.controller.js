const Idea = require("../models/Idea");
const TagVote = require("../models/TagVote");
const TagLeaderboard = require("../models/TagLeaderboard");
const LeaderboardPost = require("../models/LeaderboardPost");
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
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 200);

    // prefer persisted leaderboard if exists
    const board = await TagLeaderboard.findOne({ tagsKey }).lean();
    if (board) {
      const start = (page - 1) * limit;
      const pageEntries = (board.entries || []).slice(start, start + limit);
      // populate idea refs
      const ideaIds = pageEntries.map(e => e.idea);
      const ideas = await Idea.find({ _id: { $in: ideaIds } }).populate("author", "username role").lean();
      const ideaMap = Object.fromEntries(ideas.map(i => [String(i._id), i]));
      const results = pageEntries.map(e => ({ idea: ideaMap[String(e.idea)] || null, score: e.score, votes: e.votes })).filter(r => r.idea);

      return res.json({ ok: true, tags, tagsKey: tagsKey, page, limit, total: board.entries.length, results });
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

    // store in short-lived memory cache as well
    CACHE.set(tagsKey, { expires: Date.now() + CACHE_TTL * 1000, value: results });
    res.json({ ok: true, tags, tagKey: tagsKey, results, total: results.length, page, limit });
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
    // remove persisted leaderboard so it will be recomputed next time (or we could incrementally update)
    try { await TagLeaderboard.deleteOne({ tagsKey }); } catch (e) {}

    res.json({ ok: true, ideaId, tags: normalized, tagsKey, score, votes: votesCount });
  } catch (err) {
    next(err);
  }
}

// create or refresh a leaderboard for a tagsKey
async function createLeaderboard(req, res, next) {
  try {
    const tags = normalizeTags(req.body.tags || req.query.tags || req.query.tag || []);
    const tagsKey = tags.join("|");
    const limit = Math.min(Math.max(parseInt(req.body.limit || req.query.limit || "100", 10), 1), 1000);

    // compute aggregation similar to getRank
    let agg;
    if (!tagsKey) {
      agg = await TagVote.aggregate([
        { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
        { $sort: { score: -1 } },
        { $limit: limit },
      ]);
    } else {
      agg = await TagVote.aggregate([
        { $match: { tagsKey } },
        { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
        { $sort: { score: -1 } },
        { $limit: limit },
      ]);
    }

    let entries = agg.map(a => ({ idea: a._id, score: a.score, votes: a.votes }));

    // if no TagVote entries found, fallback to selecting popular ideas by view/like counts
    if ((!entries || entries.length === 0)) {
      // build a query for ideas matching tags (all tags if provided)
      let ideaQuery = {};
      if (tags.length) {
        ideaQuery = { tags: { $all: tags } };
      }
      // prefer viewCount, then likeCount, then createdAt
      const popular = await Idea.find(ideaQuery).sort({ "stats.viewCount": -1, "stats.likeCount": -1, createdAt: -1 }).limit(limit).lean();
      entries = popular.map(p => ({ idea: p._id, score: (p.stats?.viewCount ?? 0), votes: (p.stats?.likeCount ?? 0) }));
    }
    const now = new Date();
    const board = await TagLeaderboard.findOneAndUpdate(
      { tagsKey },
      { $set: { tags, entries, computedAt: now } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, _id: board._id, tags, tagsKey, entriesCount: entries.length });
  } catch (err) {
    next(err);
  }
}

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

// list recent or hottest persisted leaderboards
async function listLeaderboards(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);
    const sort = req.query.sort === "hottest" ? { "entries.score": -1 } : { computedAt: -1 };
    const boards = await TagLeaderboard.find({}).sort(sort).limit(limit).lean();
    // populate idea titles for convenience
    const ideaIds = Array.from(new Set(boards.flatMap(b => (b.entries || []).map(e => String(e.idea)))));
    const ideas = await Idea.find({ _id: { $in: ideaIds } }).lean();
    const ideaMap = Object.fromEntries(ideas.map(i => [String(i._id), i]));
    
    // get posts count for each board
    const tagsKeys = boards.map(b => b.tagsKey);
    const postsCounts = await LeaderboardPost.aggregate([
      { $match: { tagsKey: { $in: tagsKeys } } },
      { $group: { _id: "$tagsKey", count: { $sum: 1 } } }
    ]);
    const postsCountMap = Object.fromEntries(postsCounts.map(p => [p._id, p.count]));
    
    const payload = boards.map(b => ({ 
      _id: b._id, 
      tags: b.tags, 
      tagsKey: b.tagsKey, 
      computedAt: b.computedAt, 
      postsCount: postsCountMap[b.tagsKey] || 0,
      entries: (b.entries || []).slice(0,5).map(e => ({ idea: ideaMap[String(e.idea)] || null, score: e.score, votes: e.votes })) 
    }));
    res.json({ ok: true, boards: payload });
  } catch (err) {
    next(err);
  }
}

// get single leaderboard by ID with all entries and posts
async function getLeaderboardById(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return invalidId("Invalid leaderboard id");

    const board = await TagLeaderboard.findById(id).lean();
    if (!board) return invalidId("Leaderboard not found");

    // get all entries with idea details
    const ideaIds = (board.entries || []).map(e => e.idea);
    const ideas = await Idea.find({ _id: { $in: ideaIds } }).populate("author", "username role").lean();
    const ideaMap = Object.fromEntries(ideas.map(i => [String(i._id), i]));
    const entries = (board.entries || []).map(e => ({ idea: ideaMap[String(e.idea)] || null, score: e.score, votes: e.votes })).filter(e => e.idea);

    res.json({ ok: true, _id: board._id, tags: board.tags, tagsKey: board.tagsKey, computedAt: board.computedAt, entries, entriesCount: entries.length });
  } catch (err) {
    next(err);
  }
}

// search leaderboards by tags - returns exact match and related ones
async function searchLeaderboards(req, res, next) {
  try {
    const tags = normalizeTags(req.query.q || req.query.tags || []);
    if (tags.length === 0) return res.json({ ok: true, exact: null, related: [] });

    const tagsKey = tags.join("|");
    
    // try exact match first
    const exact = await TagLeaderboard.findOne({ tagsKey }).lean();

    // find related boards (partial tag matches)
    const related = await TagLeaderboard.find({ tagsKey: { $ne: tagsKey } }).lean();
    
    // score related boards by tag overlap
    const scored = related.map(b => {
      const boardTags = b.tags || [];
      const overlap = tags.filter(t => boardTags.includes(t)).length;
      return { board: b, overlap };
    })
    .filter(s => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 5)
    .map(s => s.board);

    // get posts count for exact and related boards
    const allBoards = [exact, ...scored].filter(Boolean);
    const tagsKeys = allBoards.map(b => b.tagsKey);
    const postsCounts = await LeaderboardPost.aggregate([
      { $match: { tagsKey: { $in: tagsKeys } } },
      { $group: { _id: "$tagsKey", count: { $sum: 1 } } }
    ]);
    const postsCountMap = Object.fromEntries(postsCounts.map(p => [p._id, p.count]));

    const exactPayload = exact ? { 
      _id: exact._id, 
      tags: exact.tags, 
      tagsKey: exact.tagsKey, 
      entriesCount: exact.entries?.length || 0,
      postsCount: postsCountMap[exact.tagsKey] || 0 
    } : null;
    const relatedPayload = scored.map(b => ({ 
      _id: b._id, 
      tags: b.tags, 
      tagsKey: b.tagsKey, 
      entriesCount: b.entries?.length || 0,
      postsCount: postsCountMap[b.tagsKey] || 0 
    }));

    res.json({ ok: true, searchTags: tags, exact: exactPayload, related: relatedPayload });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRank, vote, suggestTags, createLeaderboard, listLeaderboards, getLeaderboardById, searchLeaderboards };
