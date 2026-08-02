// src/models/BranchLike.js
// 分支视频点赞去重表：{ user, video } 唯一索引，配合 upsert 实现幂等点赞。
// BranchVideo.likes 由该表 countDocuments 回写，避免并发下计数漂移。
const mongoose = require("mongoose");

const branchLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
  },
  { timestamps: true }
);

branchLikeSchema.index({ user: 1, video: 1 }, { unique: true });

module.exports = mongoose.model("BranchLike", branchLikeSchema);
