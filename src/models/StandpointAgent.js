// src/models/StandpointAgent.js
// 立场展开（Standpoint / Stance-Unfold）——每个用户一个“后台监控代理”
// 代表后台容器 + OpenClaw 监控引擎；离线时自动检测并展开回复。
const mongoose = require("mongoose");

const STANCES = ["aggressive", "peaceful", "rational", "sarcastic"];
const AGENT_STATUSES = ["stopped", "running", "paused"];

// 绑定账号（演示用，仅登记 平台+handle，不存储真实凭证）
const standpointAccountSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    platform: { type: String, required: true, trim: true, maxlength: 40 },
    handle: { type: String, required: true, trim: true, maxlength: 80 },
    connected: { type: Boolean, default: true },
  },
  { _id: false }
);

const standpointConfigSchema = new mongoose.Schema(
  {
    stance: { type: String, enum: STANCES, default: "rational" },
    personaText: { type: String, default: "", maxlength: 2000 },
    personalInfo: { type: String, default: "", maxlength: 4000 },
    autoSendEnabled: { type: Boolean, default: false },
    replyToMalicious: { type: Boolean, default: true },
    replyToQuestions: { type: Boolean, default: true },
  },
  { _id: false }
);

const standpointStatsSchema = new mongoose.Schema(
  {
    detected: { type: Number, default: 0 },
    drafted: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
  },
  { _id: false }
);

const standpointAgentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    status: { type: String, enum: AGENT_STATUSES, default: "stopped", index: true },
    accounts: { type: [standpointAccountSchema], default: [] },
    config: { type: standpointConfigSchema, default: () => ({}) },
    stats: { type: standpointStatsSchema, default: () => ({}) },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("StandpointAgent", standpointAgentSchema);
module.exports.STANCES = STANCES;
module.exports.AGENT_STATUSES = AGENT_STATUSES;
