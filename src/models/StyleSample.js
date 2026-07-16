// src/models/StyleSample.js
// 风格记忆原料：用户【自己提供】的发言样本。
// 边界：绝不自动爬取平台账号历史 —— 样本只来自用户粘贴，或用户主动在自己的主页/评论页用插件就地收集。
const mongoose = require("mongoose");

const styleSampleSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    // text 太长（最长 1000）不能直接建唯一索引，改用 sha1(规范化 text) 的 hex 做去重键
    hash: { type: String, required: true },
    source: { type: String, enum: ["paste", "capture"], default: "paste" },
    platform: { type: String, default: "", trim: true, maxlength: 40 },
  },
  { timestamps: true }
);

// 同一用户的同一段发言只收录一次（重复提交算 skipped，不算失败）
styleSampleSchema.index({ user: 1, hash: 1 }, { unique: true });
// 列表分页 / 生成档案时按时间倒序取最近样本
styleSampleSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("StyleSample", styleSampleSchema);
