// src/models/BranchCommentLike.js
// 评论点赞去重表：{ user, comment } 唯一索引，配合 upsert 实现幂等点赞。
// BranchComment.likes 由该表 countDocuments 回写，避免并发下计数漂移。
//
// ★ 为什么单开一张表而不是在 BranchComment 上挂一个 likedBy 数组：
//   ① 数组要靠 $addToSet 去重，而"这次到底加没加进去"在同一个更新里读不出来 ——
//      而通知**必须**只在真正新增的那一次发（否则重复 POST 就是一台发通知的机器）；
//   ② 一条爆款评论的 likedBy 会无限长，且每次读评论列表都把它整份拖出来。
//   与 BranchLike.js 是同构的，改一处要想想另一处（铁律六的精神）。
const mongoose = require("mongoose");

const branchCommentLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    comment: { type: mongoose.Schema.Types.ObjectId, ref: "BranchComment", required: true, index: true },
  },
  { timestamps: true }
);

branchCommentLikeSchema.index({ user: 1, comment: 1 }, { unique: true });

module.exports = mongoose.model("BranchCommentLike", branchCommentLikeSchema);
