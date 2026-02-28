/**
 * @file DirectMessage.js - 私信模型
 * @category Model
 * @description 存储两个用户之间的一对一私信对话
 * 
 * 业务规则:
 * - 两个用户的私信共享同一个对话（不区分方向）
 * - 每条消息记录发送者和接收者
 * - 支持已读状态追踪
 * 
 * 索引:
 * - 复合索引：conversationId + createdAt （分页查询消息）
 * - 索引：conversationId （快速定位对话）
 * - 索引：participants （查询用户参与的所有对话）
 */

const mongoose = require("mongoose");

const DirectMessageSchema = new mongoose.Schema(
  {
    // 对话ID（通过排序两个userId生成）
    conversationId: {
      type: String,
      required: true,
      index: true,
    },
    
    // 参与者（数组，包含两个用户ID）
    participants: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }],
    
    // 发送者
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    // 接收者
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    
    // 消息内容
    content: {
      type: String,
      required: true,
    },
    
    // 已读状态
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// 复合索引用于分页查询对话中的消息
DirectMessageSchema.index({ conversationId: 1, createdAt: -1 });

// 查询用户参与的所有对话
DirectMessageSchema.index({ participants: 1 });

module.exports = mongoose.model("DirectMessage", DirectMessageSchema);
