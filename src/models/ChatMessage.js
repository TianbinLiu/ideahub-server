/**
 * @file ChatMessage.js - 会话里的一条消息
 * @category Model
 * @collection chatmessages
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节
 *
 * ★ 两份文本：displayText 给人看（剥掉了演出标签）；modelText 是模型当时的原文（带 [情绪][face:][action:]）。
 *   发给模型的历史用 modelText —— 历史里的示范不带标签，模型会学着不打标签，前端就解析不到表情
 *   （与 companion.service.personaExampleMessages 给 few-shot 补标签是同一个道理）。
 * ★ compacted=true 的消息**原文照样保留**给用户翻历史，只是不再发给模型（它们已经被提纯进了摘要与记忆卡）。
 * ★ kind=divider 是提纯时插进对话流的一条分隔提示（「已整理前 N 轮…」），role=system，永远不发给模型。
 *
 * @field thread {ObjectId}
 * @field user {ObjectId} 冗余一份，删账号时能按人批量删
 * @field seq {Number} 会话内序号（从 1 起）
 * @field role {String} user | assistant | system
 * @field kind {String} msg | divider
 * @field displayText {String}
 * @field modelText {String}
 * @field estTokens {Number} 本地估算的 token 数（未乘校准系数）
 * @field compacted {Boolean} 已被提纯，不再进上下文
 * @field partial {Boolean} 回复中途客户端断开，只存下了半截
 *
 * @index {thread:1, seq:1} unique
 * @index {user:1}
 * @used_in services/chatMemory.service.js
 */
const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    thread: { type: mongoose.Schema.Types.ObjectId, ref: "ChatThread", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    seq: { type: Number, required: true },
    role: { type: String, enum: ["user", "assistant", "system"], required: true },
    kind: { type: String, enum: ["msg", "divider"], default: "msg" },
    displayText: { type: String, default: "", maxlength: 8000 },
    modelText: { type: String, default: "", maxlength: 12000 },
    estTokens: { type: Number, default: 0 },
    compacted: { type: Boolean, default: false },
    partial: { type: Boolean, default: false },
  },
  { timestamps: true },
);

chatMessageSchema.index({ thread: 1, seq: 1 }, { unique: true });
chatMessageSchema.index({ user: 1 });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
