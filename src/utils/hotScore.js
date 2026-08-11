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

module.exports = { hotScore, roundHeat };
