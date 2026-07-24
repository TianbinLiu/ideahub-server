// src/models/ScenarioSession.js
// 情景模拟「对局」—— 一次从进入 play 到结束的完整对话记录（chat 场景）。
//
// 生命周期：
//   进入 play 发第一条消息时 get-or-create {scenario,user,status:"active"}（同一用户同一情景
//   至多一个 active 对局；结束后再玩自动开新局）→ 每轮 append 用户消息 + AI 回复
//   → 结束（三种）：manual 用户手动 / derailed AI 判定用户发言脱离情景到「正常人会拒绝
//   继续沟通」的程度（AI 最后回复即为拒续表态）/ completed AI 判定情景目标演完
//   → 结束时由 AI 生成 evaluation（0-100 评分 + 评语）。
//
// 可见性：默认私有（只有本人可回放）。用户主动「分享」（shared=true）后进入情景详情页
// 的「大家的对话」列表，他人可回放与点赞（ScenarioSessionLike）。
const mongoose = require("mongoose");

const SESSION_END_REASONS = ["", "manual", "derailed", "completed"];

const sessionMessageSchema = new mongoose.Schema(
  {
    mid: { type: String, required: true },
    // 对齐 scenario.participants 的 id（用户消息 = isSelf 参与者 id；AI 回复按 authorName 匹配）
    senderId: { type: String, default: "" },
    senderName: { type: String, default: "", trim: true, maxlength: 80 },
    senderAvatar: { type: String, default: "" },
    isUser: { type: Boolean, default: false },
    isAi: { type: Boolean, default: false },
    text: { type: String, default: "", trim: true, maxlength: 4000 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const scenarioSessionSchema = new mongoose.Schema(
  {
    scenario: { type: mongoose.Schema.Types.ObjectId, ref: "Scenario", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["active", "ended"], default: "active", index: true },
    endReason: { type: String, enum: SESSION_END_REASONS, default: "" },
    platform: { type: String, default: "generic" },
    messages: { type: [sessionMessageSchema], default: [] },
    evaluation: {
      // null = 未评（active 或评估失败）；0-100
      score: { type: Number, default: null, min: 0, max: 100 },
      comment: { type: String, default: "", maxlength: 2000 },
      _id: false,
    },
    shared: { type: Boolean, default: false, index: true },
    likeCount: { type: Number, default: 0, min: 0 },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// 同一用户同一情景至多一个 active 对局（get-or-create 的并发闸）
scenarioSessionSchema.index(
  { scenario: 1, user: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);
// 详情页「大家的对话」：shared 按热度/时间
scenarioSessionSchema.index({ scenario: 1, shared: 1, likeCount: -1, endedAt: -1 });

module.exports = mongoose.model("ScenarioSession", scenarioSessionSchema);
module.exports.SESSION_END_REASONS = SESSION_END_REASONS;
