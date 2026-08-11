// src/models/BranchAssetLike.js
// 卡片/卡组的点赞与收藏**去重表**，照抄 BranchLike 的思路（{user, video} 唯一索引 + upsert）。
//
// 为什么点赞和收藏合成一张表而不是两张：两者的语义完全一样（「这个人对这个实体做过这件事」，
// 可撤销、必须幂等），只有 action 不同。拆两张表就是把同一条规则写两遍 —— 幂等、
// 计数回写、跨账号统计都得各写一份（铁律六）。
//
// ★ BranchAssetStat 的 likes/bookmarks 由本表 countDocuments 回写，**不盲目 $inc**：
//   重复点赞、并发、以及"点了又取消"三种情况下 $inc 都会漂移，而漂移的数字校不回来。
const mongoose = require("mongoose");
const { ASSET_KINDS, ASSET_ACTIONS } = require("../schemas/branchAsset.schemas");

const branchAssetLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ASSET_KINDS, required: true },
    key: { type: String, required: true, trim: true, maxlength: 120 },
    action: { type: String, enum: ASSET_ACTIONS, required: true },
  },
  { timestamps: true, versionKey: false }
);

// 幂等的地基：同一个人对同一个实体的同一个动作只能有一条
branchAssetLikeSchema.index({ user: 1, kind: 1, key: 1, action: 1 }, { unique: true });
// 回写计数时按 { kind, key, action } 数
branchAssetLikeSchema.index({ kind: 1, key: 1, action: 1 });

module.exports = mongoose.model("BranchAssetLike", branchAssetLikeSchema);
