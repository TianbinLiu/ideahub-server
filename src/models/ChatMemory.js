/**
 * @file ChatMemory.js - 数字人「记得的事」（事实卡）
 * @category Model
 * @collection chatmemories
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节
 *
 * 提纯（chatMemory.service.compactThread）时由模型从旧对话里提炼出来：称呼、偏好、正在做的创作、答应过的事……
 * 用户可以在「小梦记得的事」里逐条查看、编辑、删除、回退上一版、一键清空。
 *
 * ★ 作用域：
 *   · companion：跨会话，按人（不按人格——换了人格，关于「你」的事实照样成立）；
 *   · support：**只在本会话内**（sourceThreads 含当前会话）。客服是一次性事务，开新会话就清零，
 *     不把上一次的猜测带成这一次的承诺（设计稿 §B1）。
 * ★ 删某个会话时，从它提炼出的事实卡（sourceThreads 含它）一起硬删 —— 比「删对话不删记忆」更严（设计稿 §B1）。
 * ★ 不做 TTL：事实卡保留到用户删除或账号删除。
 *
 * @field user {ObjectId}
 * @field scene {String} companion | support
 * @field text {String} 一条事实（≤200）
 * @field category {String} 见 chatMemory.service.MEMORY_CATEGORIES
 * @field sourceThreads {ObjectId[]} 从哪些会话提炼出来的
 * @field pinned {Boolean} 超出条数上限时不会被挤掉
 * @field prevText {String} 上一版（编辑 / 提纯更新前），可回退
 *
 * @index {user:1, scene:1, updatedAt:-1}
 * @index {sourceThreads:1}
 * @used_in services/chatMemory.service.js
 */
const mongoose = require("mongoose");

const chatMemorySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    scene: { type: String, enum: ["companion", "support"], required: true },
    text: { type: String, required: true, maxlength: 200 },
    category: { type: String, default: "other", maxlength: 20 },
    sourceThreads: [{ type: mongoose.Schema.Types.ObjectId, ref: "ChatThread" }],
    pinned: { type: Boolean, default: false },
    prevText: { type: String, default: "", maxlength: 200 },
  },
  { timestamps: true },
);

chatMemorySchema.index({ user: 1, scene: 1, updatedAt: -1 });
chatMemorySchema.index({ sourceThreads: 1 });

module.exports = mongoose.model("ChatMemory", chatMemorySchema);
