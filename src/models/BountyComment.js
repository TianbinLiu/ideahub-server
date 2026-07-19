// src/models/BountyComment.js
// 赏金任务介绍页的讨论评论区（可发图、支持一层楼中楼）。
//
// ⚠️ 情景/人格的讨论区走通用模型 ArenaComment（targetType+target+content），本模型【刻意不迁移】：
// 它早已上线、可能已有线上数据，为「模型统一」去做 text->content / bounty->target 的数据迁移
// 是白担丢评论的风险。理由详见 models/ArenaComment.js 文件头。
const mongoose = require("mongoose");

const bountyCommentSchema = new mongoose.Schema(
  {
    bounty: { type: mongoose.Schema.Types.ObjectId, ref: "Bounty", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    imageUrl: { type: String, default: "" },
    // 楼中楼；null = 顶楼。只允许一层：控制器保证 parentId 指向的一定是顶楼。
    parentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

bountyCommentSchema.index({ bounty: 1, createdAt: -1 });

module.exports = mongoose.model("BountyComment", bountyCommentSchema);
