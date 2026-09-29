"use strict";
// 引流位度量（tutor 仓 docs/06 §5.1「度量（每条都能防刷）」，2026-09-29 M3）：各入口带 ?from=，落到 /tutor 时记一行。
// **只记不奖励**，所以防刷只要三样：① 来源白名单（core/publish/referral.REFERRAL_FROM，未知值不记）；② 同一主体（登录 = 用户 id；
// 游客 = IP 指纹 sha256 前 32 位，**不存明文 IP**）同一来源每天一条（唯一索引，撞上 = recorded:false）；③ TTL 自动清（core REFERRAL_TTL_DAYS）。
// 照 SearchHistory 那类轻量表，不建埋点系统。写入只在 services/tutorMetrics.service.recordReferral 一处。
const mongoose = require("mongoose");
const { REFERRAL_TTL_DAYS } = require("../tutor/core/publish/referral");

const tutorReferralSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, maxlength: 80 }, // "u:<userId>" | "ip:<hash32>"
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    from: { type: String, required: true, maxlength: 40 },
    path: { type: String, default: "/tutor", maxlength: 120 },
    day: { type: String, required: true, maxlength: 10 }, // UTC 日 YYYY-MM-DD（core referralDay），去重粒度
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
tutorReferralSchema.index({ day: 1, from: 1, subject: 1 }, { unique: true });
tutorReferralSchema.index({ createdAt: 1 }, { expireAfterSeconds: REFERRAL_TTL_DAYS * 86400 });
tutorReferralSchema.index({ from: 1, createdAt: -1 });

module.exports = mongoose.model("TutorReferral", tutorReferralSchema);
