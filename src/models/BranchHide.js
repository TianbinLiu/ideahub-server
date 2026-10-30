// 「不感兴趣」（2026-10-30）：用户对某条作品的负反馈。只做一件事 —— 这条从此不进他的列表（首页 / 分区 / 搜索 / 关注流）。
// ★ 与 BranchCollect 同形（按人 + 按作品唯一），但**不是**互动计数：不给作者看、不进作品的任何数字；
//   抖音 / TikTok 的「不感兴趣」也只影响本人的推荐。拿它做推荐权重是另一件事（今天没有推荐权重，列表按时间倒序）。
// ★ 作者主页上**不**生效（controller 的 listVideos：带 authorFilter 的查询不加这一条）：人点进某个作者的主页是主动要看他的全部作品。
const mongoose = require("mongoose");

const branchHideSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
  },
  { timestamps: true },
);

branchHideSchema.index({ user: 1, video: 1 }, { unique: true });

module.exports = mongoose.model("BranchHide", branchHideSchema);
