/**
 * @file SupportTicket.js - 客服工单（AI 客服解决不了 → 转人工）
 * @category Model
 * @collection supporttickets
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * 一条工单 = 用户在 App「AI 客服」里点了「转人工」那一刻的快照：
 *   - transcript：转人工前和数字人的对话（最近 30 条），人工客服打开就知道用户问过什么、AI 答了什么
 *   - summary / category：由 AI 归纳（失败就退回用户原话），方便管理员扫一眼分类处理
 *   - replies：人工与用户在这张工单里的后续往来（现在靠通知 + 邮件异步，将来在线客服实时回复也落这里）
 *
 * ★ 为什么不复用 Idea(ideaType=feedback)：反馈 idea 是公开内容（进想法流、能被点赞评论），
 *   工单里有账号、订单、任务号这类隐私信息，必须是私有对象、只有本人和管理员可见。
 * ★ 状态机 open → in_progress → resolved/closed 只允许管理员推进；用户能做的只有追加消息。
 *
 * @field userId {ObjectId} 提交人（ref User）
 * @field status {String} open | in_progress | resolved | closed
 * @field category {String} billing | account | content | bug | other
 * @field subject {String} 一句话标题（AI 归纳或用户原话前 60 字）
 * @field summary {String} AI 归纳的问题摘要（≤1000）
 * @field note {String} 用户转人工时自己补的一句话（≤500）
 * @field contactEmail {String} 用户留的联系邮箱（可空；QQ/手机号账号没有真实邮箱）
 * @field transcript {Array} [{ role: user|assistant, content, at }]，最近 30 条
 * @field replies {Array} [{ by: admin|user, userId, content, at }]
 * @field handler {ObjectId} 接手的管理员
 * @field handledAt {Date} 首次被管理员处理的时间
 * @field lastMessageAt {Date} 最后一条消息（工单列表按它排）
 *
 * @index {status:1, createdAt:-1} 管理员队列
 * @index {userId:1, createdAt:-1} 用户「我的工单」
 * @used_in routes/support.routes.js, services/support.service.js
 */
const mongoose = require("mongoose");

const STATUSES = ["open", "in_progress", "resolved", "closed"];
const CATEGORIES = ["billing", "account", "content", "bug", "other"];
const TRANSCRIPT_MAX = 30;
const REPLY_MAX_CHARS = 2000;

const transcriptItemSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, maxlength: 2000 },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const replySchema = new mongoose.Schema(
  {
    by: { type: String, enum: ["admin", "user"], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    content: { type: String, required: true, maxlength: REPLY_MAX_CHARS },
    at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const supportTicketSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: STATUSES, default: "open", index: true },
    category: { type: String, enum: CATEGORIES, default: "other" },
    subject: { type: String, default: "", maxlength: 120 },
    summary: { type: String, default: "", maxlength: 1000 },
    note: { type: String, default: "", maxlength: 500 },
    contactEmail: { type: String, default: "", maxlength: 120 },
    transcript: { type: [transcriptItemSchema], default: [] },
    replies: { type: [replySchema], default: [] },
    handler: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// 管理员队列：先看没处理的、按新到旧
supportTicketSchema.index({ status: 1, createdAt: -1 });
// 用户自己的工单列表
supportTicketSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
module.exports.STATUSES = STATUSES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.TRANSCRIPT_MAX = TRANSCRIPT_MAX;
module.exports.REPLY_MAX_CHARS = REPLY_MAX_CHARS;
