/**
 * @file ChatUsageLog.js - 数字人对话每次调模型的 token 用量（只存数字，不存内容）
 * @category Model
 * @collection chatusagelogs
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节
 *
 * 用途：上下文用量显示的依据（上一轮的 prompt + completion）、校准本地估算、上线后看「事实卡够不够用」
 * 决定要不要做向量回忆（设计稿 §C7）。
 * ★ 这里只有数字，所以可以直接用 Mongo TTL（createdAt + 180 天，设计稿 §B1）；删会话 / 删账号时照样一并硬删。
 *
 * @field thread {ObjectId}
 * @field user {ObjectId}
 * @field scene {String}
 * @field kind {String} reply（一轮回复）| compact（一次提纯）
 * @field model {String}
 * @field promptTokens / completionTokens / cacheHitTokens / cacheMissTokens / reasoningTokens {Number}
 *
 * @index {createdAt:1} TTL 180 天
 * @index {thread:1}
 * @index {user:1}
 * @used_in services/chatMemory.service.js
 */
const mongoose = require("mongoose");

const RETENTION_SECONDS = 180 * 24 * 60 * 60;

const chatUsageLogSchema = new mongoose.Schema(
  {
    thread: { type: mongoose.Schema.Types.ObjectId, ref: "ChatThread", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    scene: { type: String, enum: ["companion", "support"], required: true },
    kind: { type: String, enum: ["reply", "compact"], required: true },
    model: { type: String, default: "" },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    cacheHitTokens: { type: Number, default: 0 },
    cacheMissTokens: { type: Number, default: 0 },
    reasoningTokens: { type: Number, default: 0 },
  },
  { timestamps: true },
);

chatUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
chatUsageLogSchema.index({ thread: 1 });
chatUsageLogSchema.index({ user: 1 });

module.exports = mongoose.model("ChatUsageLog", chatUsageLogSchema);
