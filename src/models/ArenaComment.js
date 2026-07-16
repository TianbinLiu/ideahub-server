// src/models/ArenaComment.js
// 情景（Scenario）/ 人格（Persona）详情页【讨论区】的评论（可发图、支持一层楼中楼）。
//
// ⚠️ 与 BountyComment 的不一致是【有意为之】，不是遗漏：
//   - 情景与人格的讨论区都是全新功能、库里没有历史数据，所以合用这一份通用模型
//     （targetType 区分归属），好过复制两份几乎一样的 schema/controller 各自漂移。
//   - 赏金的 BountyComment 早已上线、【可能已有线上数据】，把它迁进来要写数据迁移
//     （text -> content、bounty -> targetType+target），迁移失败会丢用户评论——
//     为了「模型统一」这种纯审美收益去担这个风险不划算。故 BountyComment 保持独立、
//     原地加 parentId 补齐楼中楼，字段名 text 也维持不变。
//   - 前端由 client/src/components/CommentThread.tsx 统一 UI，两套后端形状的差异
//     在 client/src/api.ts 的 arena comment 适配层里抹平（bounty 的 text <-> content）。
const mongoose = require("mongoose");

const ARENA_COMMENT_TARGETS = ["scenario", "persona"];

const arenaCommentSchema = new mongoose.Schema(
  {
    targetType: { type: String, enum: ARENA_COMMENT_TARGETS, required: true },
    // 指向 Scenario 或 Persona，集合由 targetType 决定，故不设 ref（不做 populate）
    target: { type: mongoose.Schema.Types.ObjectId, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    // 与赏金讨论区对齐，允许发图
    imageUrl: { type: String, default: "" },
    // 楼中楼；null = 顶楼。只允许一层：控制器保证 parentId 指向的一定是顶楼。
    parentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

arenaCommentSchema.index({ targetType: 1, target: 1, createdAt: -1 });

module.exports = mongoose.model("ArenaComment", arenaCommentSchema);
module.exports.ARENA_COMMENT_TARGETS = ARENA_COMMENT_TARGETS;
