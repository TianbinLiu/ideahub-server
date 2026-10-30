// src/models/TutorUsage.js
// 老师人格每一发模型调用的用量（只有数字与 kind，没有正文、没有密钥）—— tutor 仓 docs/10 的账本，GET /api/tutor/usage-ledger 从这里读、
// `npm run dogfood` 拿它推三个单价的 p95。形状 = core/ai/client.js 吐给 onUsage 的那一条。
// ★ 与 ChatUsageLog 同一条纪律：只存数字所以能 TTL（180 天）；不复用它是因为那张表的 scene / thread 是陪聊专用的枚举与必填外键。
const mongoose = require("mongoose");

const RETENTION_SECONDS = 180 * 24 * 60 * 60;

const tutorUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", index: true },
    at: { type: Date, required: true },
    kind: { type: String, required: true, index: true }, // turn / preview / quiz-grade / distill / stages / stage / card / scan
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }, // 阶段 / 重试次数这类上下文，不含正文
    model: { type: String, default: "" },
    stream: { type: Boolean, default: false },
    maxTokens: { type: Number },
    promptChars: { type: Number, default: 0 },
    completionChars: { type: Number, default: 0 },
    promptTokens: { type: Number, default: null },
    completionTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    ttfbMs: { type: Number, default: null },
    finishReason: { type: String, default: null },
    ok: { type: Boolean, default: false },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

tutorUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
tutorUsageSchema.index({ at: 1 });

module.exports = mongoose.model("TutorUsage", tutorUsageSchema);
