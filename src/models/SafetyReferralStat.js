/**
 * @file SafetyReferralStat.js - 危机转介的**匿名**计数（加州 SB 243 §22603 年度报告用）
 * @category Model
 * @collection safetyreferralstats
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节
 *
 * §22603 要求从 2027-07-01 起每年向加州自杀预防办公室报告「发出危机转介的次数」，并且
 * **报告中不得包含用户标识或个人信息**。所以这张表刻意只有五个字段：
 *   day（UTC 日期）+ scene + trigger + region → count
 * ★★ 永远不要在这里加 user / thread / ip / 原文 / userAgent。加了就等于把「谁在危机中」这件事
 *    长期留档——那既违背报告口径，也是最不该存的一类数据。tests/chatSafety.spec.js 有一条测试
 *    专门断言这张表的字段集合，改 schema 会让它失败。
 * ★ 不设 TTL：它是逐日聚合的计数，体量极小（每天最多 场景数 × 2 × 3 条），而且 2027 年起要按年汇总。
 *
 * @field day {String} UTC 日期 YYYY-MM-DD
 * @field scene {String} companion | support | persona_preview …
 * @field trigger {String} input（用户表达）| output（拦下模型输出）
 * @field region {String} US | CN | OTHER
 * @field count {Number}
 *
 * @index {day:1, scene:1, trigger:1, region:1} unique
 * @used_in services/chatSafety.service.js
 */
const mongoose = require("mongoose");

const safetyReferralStatSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    scene: { type: String, required: true, maxlength: 32 },
    trigger: { type: String, enum: ["input", "output"], required: true },
    region: { type: String, enum: ["US", "CN", "OTHER"], required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

safetyReferralStatSchema.index({ day: 1, scene: 1, trigger: 1, region: 1 }, { unique: true });

module.exports = mongoose.model("SafetyReferralStat", safetyReferralStatSchema);
