//OtpToken.js

const mongoose = require("mongoose");

const otpTokenSchema = new mongoose.Schema(
  {
    target: { type: String, required: true, index: true }, // email 或 phone
    purpose: { type: String, required: true, index: true }, // email_register / phone_login ...
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: true },
    // resend 冷却
    lastSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// TTL：过期自动清理（Mongo 会延迟执行，正常）
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// 目标+用途（查最新一条即可）
otpTokenSchema.index({ target: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model("OtpToken", otpTokenSchema);
