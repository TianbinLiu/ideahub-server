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
    // 可选封面图（Cloudinary URL，前端走 /api/uploads/image 拿）
    coverImageUrl: { type: String, default: "" },
    tags: { type: [String], default: [] },
    slots: { type: Number, default: 1, min: 1 },
    status: { type: String, enum: BOUNTY_STATUSES, default: "open", index: true },
    deadline: { type: Date, default: null },
    stats: { type: bountyStatsSchema, default: () => ({}) },
    approvedCount: { type: Number, default: 0, min: 0 },

    // ── 托管（escrow）：发布时从发布者账上扣下来、锁在这个悬赏里的点数 ──
    //
    // escrowPoints 是「该 bounty 下所有 user:null 分录 delta 之和」的镜像，两者必须恒等。
    // 为什么要存这个冗余字段：账本求和【没法做条件原子更新】。有了它才能写出
    //   findOneAndUpdate({_id, escrowPoints:{$gte:reward}}, {$inc:{escrowPoints:-reward}})
    // 这种「判断+扣减」一次完成的更新 —— 这是并发审批不超付（I2）的唯一保证。
    // ★任何改动 escrowPoints 的地方都必须同时写一对和为零的分录（I1），反之亦然。
    escrowPoints: { type: Number, default: 0, min: 0 },

    // 结算时间戳：托管已退还发布者。null = 还没结算。
    // ★这是「反复点关闭不会反复退款」（I3）的那把锁：退款前用
    //   findOneAndUpdate({_id, refundedAt:null}, {$set:{refundedAt:now, escrowPoints:0}})
    //   原子地抢占，抢不到的调用者直接跳过。绝不能改成先 find 再 save。
    // 有值即视为【终态】：不能再审批通过、不能设回 open、不能改 reward/slots
    //   —— 托管已经空了，再放行只会得到一个永远发不出赏金的悬赏。
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

bountySchema.index({ status: 1, createdAt: -1 });
bountySchema.index({ author: 1, updatedAt: -1 });

module.exports = mongoose.model("Bounty", bountySchema);
module.exports.BOUNTY_PLATFORMS = BOUNTY_PLATFORMS;
module.exports.BOUNTY_STATUSES = BOUNTY_STATUSES;
