// src/controllers/searchHistory.controller.js
// 搜索历史与联想：
// - GET    /api/me/search-history?prefix=&limit=  我的历史（前缀过滤，最近优先）
// - DELETE /api/me/search-history/:id             删一条
// - DELETE /api/me/search-history                 清空
// - GET    /api/search/suggest?prefix=&limit=     联想（personal=我的历史，global=全站热词聚合）
//
// 记录侧在 ideas.controller.listIdeas（带 q 的请求 fire-and-forget upsert）。
// 全站热词聚合按 query 汇总 count —— 也是后续「按搜索兴趣推荐」的数据地基。
const mongoose = require("mongoose");
const SearchHistory = require("../models/SearchHistory");
const { invalidId, notFound } = require("../utils/http");

/** 前缀归一：小写 + 截断；转义正则元字符防注入 */
function toPrefixRegex(raw) {
  const prefix = String(raw || "").trim().toLowerCase().slice(0, 120);
  if (!prefix) return null;
  return new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function listMySearchHistory(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10) || 10, 1), 20);
    const prefixRegex = toPrefixRegex(req.query.prefix);
    const filter = { user: req.user._id, ...(prefixRegex ? { query: prefixRegex } : {}) };
    const entries = await SearchHistory.find(filter)
      .sort({ lastSearchedAt: -1 })
      .limit(limit)
      .select("_id query count lastSearchedAt")
      .lean();
    res.json({ ok: true, entries });
  } catch (err) {
    next(err);
  }
}

async function removeMySearchHistory(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) invalidId("Invalid history id");
    const result = await SearchHistory.deleteOne({ _id: id, user: req.user._id });
    if (!result.deletedCount) notFound("History entry not found");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function clearMySearchHistory(req, res, next) {
  try {
    await SearchHistory.deleteMany({ user: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** 全站热词聚合：$group by query 汇总 count。★不做 $addToSet（把所有 user id 收进内存数组太贵） */
function aggregateHotQueries(match, take) {
  return SearchHistory.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: "$query", totalCount: { $sum: "$count" } } },
    { $sort: { totalCount: -1 } },
    { $limit: take },
    { $project: { _id: 0, query: "$_id", totalCount: 1 } },
  ]);
}

// 空 prefix 的全站热词走进程内缓存（评审实锤）：搜索框一 focus 就打这条路，
// 匿名也可达，而无 $match 的全表聚合没有任何索引可用 —— 不能每次现算。
// 60s 新鲜度对「大家都在搜」绰绰有余。
const HOT_CACHE_MS = 60 * 1000;
let hotQueriesCache = { at: 0, rows: [] };

async function getHotQueriesCached(take) {
  const now = Date.now();
  if (now - hotQueriesCache.at < HOT_CACHE_MS && hotQueriesCache.rows.length >= 0) {
    return hotQueriesCache.rows.slice(0, take);
  }
  const rows = await aggregateHotQueries({}, 30);
  hotQueriesCache = { at: now, rows };
  return rows.slice(0, take);
}

/**
 * 联想（optionalAuth）：personal = 我的历史（登录才有），global = 全站热词。
 * global 剔除与 personal 重复的词，前端直接两段渲染。
 * 带 prefix 时 $match 先按 {query:1} 索引缩小再聚合；空 prefix 走缓存热词。
 */
async function suggestSearch(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10) || 8, 1), 15);
    const prefixRegex = toPrefixRegex(req.query.prefix);
    // board=1：热搜榜模式（🔥 热点面板用）——要完整的全站榜单，
    // 【不】按个人历史剔重（联想 dropdown 才剔，避免和「搜索历史」段重复展示）。
    const boardMode = String(req.query.board || "") === "1";

    const [personal, globalRows] = await Promise.all([
      req.user && !boardMode
        ? SearchHistory.find({ user: req.user._id, ...(prefixRegex ? { query: prefixRegex } : {}) })
            .sort({ lastSearchedAt: -1 })
            .limit(limit)
            .select("_id query count lastSearchedAt")
            .lean()
        : Promise.resolve([]),
      prefixRegex
        ? aggregateHotQueries({ query: prefixRegex }, limit * 2)
        : getHotQueriesCached(limit * 2),
    ]);

    const personalSet = new Set(personal.map((e) => e.query));
    const global = (boardMode ? globalRows : globalRows.filter((g) => !personalSet.has(g.query))).slice(0, limit);

    res.json({ ok: true, personal, global });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMySearchHistory, removeMySearchHistory, clearMySearchHistory, suggestSearch };
