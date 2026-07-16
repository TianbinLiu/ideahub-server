// src/models/Bounty.js
// 赏金猎人（Bounty Hunter）——用户发布的悬赏任务。
// 赏金 = 平台虚拟点数（reward:number），不是真钱，不做任何真实支付/转账。
const mongoose = require("mongoose");

const BOUNTY_PLATFORMS = [
  "weibo",
  "bilibili",
  "tieba",
  "zhihu",
  "douyin",
  "xiaohongshu",
  "instagram",
  "other",
];
const BOUNTY_STATUSES = ["open", "closed", "completed"];

const bountyStatsSchema = new mongoose.Schema(
  {
    viewCount: { type: Number, default: 0 },
    submissionCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const bountySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 5000 },
    reward: { type: Number, default: 0, min: 0 },
    platform: { type: String, enum: BOUNTY_PLATFORMS, default: "other", index: true },
    targetUrl: { type: String, default: "" },
    tags: { type: [String], default: [] },
    slots: { type: Number, default: 1, min: 1 },
    status: { type: String, enum: BOUNTY_STATUSES, default: "open", index: true },
    deadline: { type: Date, default: null },
    stats: { type: bountyStatsSchema, default: () => ({}) },
    approvedCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

bountySchema.index({ status: 1, createdAt: -1 });
bountySchema.index({ author: 1, updatedAt: -1 });

module.exports = mongoose.model("Bounty", bountySchema);
module.exports.BOUNTY_PLATFORMS = BOUNTY_PLATFORMS;
module.exports.BOUNTY_STATUSES = BOUNTY_STATUSES;
