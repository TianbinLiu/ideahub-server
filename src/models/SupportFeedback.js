/**
 * @file SupportFeedback.js - AI 客服回答的满意度（👍 / 👎）
 * @category Model
 * @collection supportfeedbacks
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * 一条 = 用户对某个回答点了一次 👍 或 👎，连问题和回答原文一起存：
 * 差评是改知识库最直接的线索（答错了什么、漏了什么），不存原文就没法复盘。
 * ★ 只追加不修改：同一个回答改主意再点，就再存一条，管理员看最新那条即可；不做去重是为了少一次查询。
 *
 * @field userId {ObjectId} 评价的人
 * @field question {String} 用户当时问的话（≤1000）
 * @field answer {String} AI 的回答（≤4000）
 * @field rating {String} up | down
 * @field reason {String} 差评原因（可空，≤200）
 *
 * @index {rating:1, createdAt:-1} 管理员看差评队列
 * @used_in routes/support.routes.js
 */
const mongoose = require("mongoose");

const RATINGS = ["up", "down"];

const supportFeedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    question: { type: String, required: true, maxlength: 1000 },
    answer: { type: String, required: true, maxlength: 4000 },
    rating: { type: String, enum: RATINGS, required: true },
    reason: { type: String, default: "", maxlength: 200 },
  },
  { timestamps: true },
);

supportFeedbackSchema.index({ rating: 1, createdAt: -1 });

module.exports = mongoose.model("SupportFeedback", supportFeedbackSchema);
module.exports.RATINGS = RATINGS;
