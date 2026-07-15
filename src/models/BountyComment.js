// src/models/BountyComment.js
// 赏金任务介绍页的讨论评论区（可发图）。
const mongoose = require("mongoose");

const bountyCommentSchema = new mongoose.Schema(
  {
    bounty: { type: mongoose.Schema.Types.ObjectId, ref: "Bounty", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    imageUrl: { type: String, default: "" },
  },
  { timestamps: true }
);

bountyCommentSchema.index({ bounty: 1, createdAt: -1 });

module.exports = mongoose.model("BountyComment", bountyCommentSchema);
