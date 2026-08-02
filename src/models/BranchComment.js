// src/models/BranchComment.js
// 分支视频评论。详情接口默认带出最新 50 条；BranchVideo.commentCount 由本表计数回写。
const mongoose = require("mongoose");

const branchCommentSchema = new mongoose.Schema(
  {
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

branchCommentSchema.index({ video: 1, createdAt: -1 });

module.exports = mongoose.model("BranchComment", branchCommentSchema);
