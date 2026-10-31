// src/utils/hotScore.js
// 「热度」的唯一公式。
//
// ★ 权重不是新拍的，是从 controllers/ideas.controller.js 的 getIdeaHotScore
//   **原样搬过来**的（likeCount*6 + commentCount*4 + bookmarkCount*3 +
//   min(viewCount, 5000)*0.04）。搬的目的就是让整个仓库只剩这一份实现：
//   ideas 那边现在调这个函数，卡片/卡组的热度也调它。规则要调（比如觉得
//   浏览权重太低）时只有一处要改，不会出现「想法榜和卡片榜按两套标准排」。
//
// ★ min(viewCount, 5000) 是刻意的封顶：浏览是**匿名可刷**的那一维（卡片/卡组的
//   浏览端点是 optionalAuth + 限流，挡得住脚本但挡不住人海），不封顶的话
//   一条被反复打开的内容能靠浏览量把真正被点赞收藏的内容压下去。
//
// ⚠ controllers/workshop.controller.js 里还有**另一个**热度公式，那是
//   ideahub-client 官网的「首页模板」在排序，与本文件是两件不同的产品，
//   字段口径也完全不重叠（layout/theme vs 卡片互动），**不要**把它合并进来。

/**
 * @param {object} [counts]
 * @param {number} [counts.likeCount]
 * @param {number} [counts.commentCount]
 * @param {number} [counts.bookmarkCount]
 * @param {number} [counts.viewCount]
 * @returns {number} 热度分（未取整，调用方自行按展示口径 round）
 */
function hotScore({ likeCount = 0, commentCount = 0, bookmarkCount = 0, viewCount = 0 } = {}) {
  const likes = Number(likeCount) || 0;
  const comments = Number(commentCount) || 0;
  const bookmarks = Number(bookmarkCount) || 0;
  const views = Number(viewCount) || 0;
  return likes * 6 + comments * 4 + bookmarks * 3 + Math.min(views, 5000) * 0.04;
}

/** 展示口径：保留两位小数。返回原始浮点会让响应里出现 6.640000000000001 这种噪音 */
function roundHeat(score) {
  return Math.round((Number(score) || 0) * 100) / 100;
}

/**
 * 「热门」页签按周轮换（2026-10-31，docs/decisions-2026-10-30.md §五「热点模板节奏」）：市场上排序用的分 = heat 按**上架时间**衰减，
 * 半衰期 7 天 —— 一周前上架、热度 100 的条目排序时只算 50，两周前只算 25，于是新上架的东西每周都有机会排到前面。
 * ★ 只给排序用：界面上的 🔥 热度数字仍是 heat（累计的点赞 / 收藏 / 浏览），这一格叫 trend、与 heat 并列下发。
 * ★ 按上架时间（publishedAt，没有就 createdAt）衰减、不按每次互动的时间：互动计数是累计数、没有时间戳，
 *   真要「这一周的互动」得改成按周分桶计数 —— 那是另一件事；这一版先让新内容轮得上。
 * ★ 没有时间（老数据 / 读不出来）= 不衰减（当作刚上架）：宁可让一条老内容多露一周，也别把它永远压到底。
 */
const TREND_HALF_LIFE_DAYS = 7;
function trendScore(heat, since, now = Date.now()) {
  const h = Number(heat) || 0;
  const t = since ? new Date(since).getTime() : NaN;
  if (!Number.isFinite(t)) return h;
  const ageDays = Math.max(0, (Number(now) - t) / 86400e3);
  return h * Math.pow(0.5, ageDays / TREND_HALF_LIFE_DAYS);
}

module.exports = { hotScore, roundHeat, trendScore, TREND_HALF_LIFE_DAYS };
