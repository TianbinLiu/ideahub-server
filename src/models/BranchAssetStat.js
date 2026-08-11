// src/models/BranchAssetStat.js
// 卡片 / 卡组的**全局**互动计数（浏览 / 点赞 / 收藏），热度由它算出来。
//
// ★★ key 的取法是本文件最容易改错的地方：
//   · kind="card" → key = **cardId**（客户端生成的稳定 id，如 mkt_xxx / card_xxx），
//     **不是 BranchCard._id**。BranchCard 的唯一索引是 { owner, cardId }，
//     同一张市场卡在库里是 N 份文档（每个装过的人一份）。把计数挂在文档上的话，
//     每个装过的人看到的都是自己那份的 0 —— 表现成「热度清零了」这种像丢数据的故障。
//     卡这个东西天然是「同一张卡」，所以计数也必须按 cardId 全局聚合。
//   · kind="deck" → key = 已发布卡组的 **_id 字符串**。卡组没有跨用户的稳定 id
//     （装走的是一份新副本，另有 sourceDeck 指回来），发布的那一份就是权威那份。
//
// ★ likes / bookmarks **不 $inc**，一律从 BranchAssetLike countDocuments 重算后 $set：
//   $inc 会在「重复点赞/并发」下漂移，而漂移出来的数字没有任何办法校回去。
//   views 是唯一一个 $inc（匿名也要能记，没法挂在账号上），所以它的去重靠另一张表：
//   BranchAssetView（同一访客同一天只算一次）。只挂限流是不够的 —— 限流只减慢速度，
//   60 次/分钟刷上一小时照样能把热度顶到几十个真人点赞的量。
const mongoose = require("mongoose");
// 种类枚举与 zod 校验共用一份（改一处漏一处的表现是「点赞 200 但计数不动」）
const { ASSET_KINDS } = require("../schemas/branchAsset.schemas");

const branchAssetStatSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ASSET_KINDS, required: true },
    key: { type: String, required: true, trim: true, maxlength: 120 },
    views: { type: Number, default: 0, min: 0 },
    likes: { type: Number, default: 0, min: 0 },
    bookmarks: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false }
);

// 一个实体只能有一条计数。upsert 并发下靠它兜底（撞 11000 就重读）
branchAssetStatSchema.index({ kind: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("BranchAssetStat", branchAssetStatSchema);
