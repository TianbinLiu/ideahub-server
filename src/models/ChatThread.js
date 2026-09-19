/**
 * @file ChatThread.js - 数字人对话的一个会话（首页看板娘陪聊 / App AI 客服）
 * @category Model
 * @collection chatthreads
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * 设计出处：app 仓 docs/character-art-privacy-context.md §B（隐私决定）与 §C（上下文窗口与自动提纯）。
 *
 * ★ 历史由服务端持有（2026-09-18 起）：以前 /chat 每次由客户端把最近 12～20 条原样带上来、服务端无状态，
 *   刷新就丢、换设备就没了，也没有任何地方能做「上下文快满就提纯」。现在客户端只发新的一句 + threadId。
 * ★ 保留期按「最后一次活跃」算（陪聊 180 天、客服 30 天），不用 Mongo TTL：TTL 只删这一行，
 *   删不到它名下的消息；清扫在 chatMemory.service.sweepExpiredChats 里惰性执行（照 assetPurge 的成方，
 *   生产是 pm2 双实例，不开常驻定时器）。
 *
 * @field user {ObjectId} 会话属于谁（只有登录用户有会话；游客的对话不落库）
 * @field scene {String} companion | support —— 两个场景的记忆**互不可见**
 * @field persona {ObjectId|null} 开会话时用的人格（只作记录；换人格不换会话）
 * @field title {String} 取第一句用户消息的前 40 字
 * @field seq {Number} 最后一条消息的序号；新消息用 $inc 原子取号
 * @field messageCount {Number}
 * @field lastActiveAt {Date} 保留期从这里算
 * @field summary {Object} 滚动摘要：text（≤600 字）/ version / coversUntilSeq（摘要覆盖到哪条 —— 发给模型的原文从它之后开始，
 *                        是提纯的提交点；ChatMessage.compacted 只给翻历史的界面用）
 * @field stats {Object} 上下文计量：lastPromptTokens / lastCompletionTokens（上一轮接口 usage；没给 usage 时是校准过的估算）/
 *                        calibK（估算校准系数）/ compactFailStreak（连续提纯失败次数，≥2 就不再自动试）/
 *                        compacting + compactingAt（提纯租约，过 chatMemory.COMPACT_LEASE_MS 视为持有者已死）/ compactedAt
 *
 * @index {user:1, scene:1, lastActiveAt:-1} 会话列表
 * @index {scene:1, lastActiveAt:1} 过期清扫
 * @used_in services/chatMemory.service.js
 */
const mongoose = require("mongoose");

const SCENES = ["companion", "support"];

const chatThreadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    scene: { type: String, enum: SCENES, required: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", default: null },
    title: { type: String, default: "", maxlength: 60 },
    seq: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },
    lastActiveAt: { type: Date, default: Date.now },
    summary: {
      text: { type: String, default: "", maxlength: 1200 },
      version: { type: Number, default: 0 },
      coversUntilSeq: { type: Number, default: 0 },
    },
    stats: {
      lastPromptTokens: { type: Number, default: 0 },
      lastCompletionTokens: { type: Number, default: 0 },
      calibK: { type: Number, default: 1 },
      compactFailStreak: { type: Number, default: 0 },
      compacting: { type: Boolean, default: false },
      compactingAt: { type: Date, default: null },
      compactedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

chatThreadSchema.index({ user: 1, scene: 1, lastActiveAt: -1 });
chatThreadSchema.index({ scene: 1, lastActiveAt: 1 });

module.exports = mongoose.model("ChatThread", chatThreadSchema);
module.exports.SCENES = SCENES;
