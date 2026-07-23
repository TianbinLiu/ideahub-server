// src/models/SearchHistory.js
// 用户搜索历史 —— 存服务器（账号维度，跨设备同步）。
//
// 两个消费方：
// 1. 搜索框交互：focus 弹「我的最近搜索」、输入时前缀联想、Tab 补全（me.routes 的 /search-history）。
// 2. 全站搜索热词聚合（search.routes 的 /suggest 的 global 段）——按 query 聚合 count，
//    这也是后续「按搜索兴趣做内容推荐」的数据地基（产品明确要积累这份数据）。
//
// 同一用户同一 query 只有一条（唯一索引），重复搜索 $inc count + 刷新 lastSearchedAt。
// query 存归一化小写（前缀联想大小写不敏感）；原样展示对搜索词无伤大雅。
const mongoose = require("mongoose");

const searchHistorySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    query: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    count: { type: Number, default: 1, min: 1 },
    lastSearchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

searchHistorySchema.index({ user: 1, query: 1 }, { unique: true });
searchHistorySchema.index({ user: 1, lastSearchedAt: -1 });
// 全局热词聚合走 query 维度
searchHistorySchema.index({ query: 1 });

module.exports = mongoose.model("SearchHistory", searchHistorySchema);
