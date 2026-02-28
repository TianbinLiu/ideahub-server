/**
 * @file MessageRequest.js - 私信请求模型
 * @category Model
 * @description 记录用户之间的私信请求，支持自动过期（7天）
 * 
 * 业务规则:
 * - 发起人不能重复请求同一用户（若请求已存在则替换）
 * - 请求包含隐藏消息，只有接受后才向接收者显示
 * - 自动过期时间：7天
 * - 状态: 'pending' | 'accepted' | 'rejected'
 * 
 * 索引:
 * - 唯一索引：fromUserId + toUserId （确保同两个用户间只有一个请求）
 * - 普通索引：toUserId, status, createdAt （用于查询待处理请求）
 */

const mongoose = require("mongoose");

const MessageRequestSchema = new mongoose.Schema(
  {
    // 发起者
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    
    // 接收者
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    
    // 请求状态: pending, accepted, rejected
    status: {
      type: String,
      required: true,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
    
    // 隐藏消息（只有接受后才向接收者显示）
    initialMessage: {
      type: String,
      required: true,
    },
    
    // 接收者查看时间
    viewedAt: {
      type: Date,
      default: null,
    },
    
    // 接受/拒绝时间
    respondedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// 唯一索引：确保同两个用户间只有一个请求
MessageRequestSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

// TTL索引：7天后自动删除 pending 状态的请求
MessageRequestSchema.index(
  { createdAt: 1 },
  { 
    expireAfterSeconds: 604800, // 7天
    partialFilterExpression: { status: "pending" }
  }
);

module.exports = mongoose.model("MessageRequest", MessageRequestSchema);
