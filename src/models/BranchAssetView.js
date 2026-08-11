// src/models/BranchAssetView.js
// 卡片/卡组「谁看过」的去重表。存在的唯一理由：BranchAssetStat.views 是个 $inc，
// 而热度公式里 views 占 min(views,5000)*0.04 —— 不去重的话 5000 次 POST（一个 IP、
// 一杯咖啡的时间）就能白拿 +200 热度，相当于 33 个真人点赞，热度榜就没有意义了。
// 限流只能减慢刷的速度，减不掉"同一个人刷一万次"这件事本身，所以必须有这张表。
//
// ★★ viewer 里**绝不存原始 IP**（那是可直接识别到人的数据，而这张表的用途只是
//   "这个访客今天数过没有"，根本不需要知道他是谁）：
//     · 已登录 → `u:<userId>:<UTC 日期>`
//     · 未登录 → `a:<sha256(日期 + pepper + IP) 前 32 位>`
//   两者都把 UTC 日期拌进 key，于是：
//     ① 同一访客同一天对同一实体只可能有一行 → 一天最多计一次；
//     ② 匿名那份的哈希**每天换一次**，跨天的两行没法被对到同一个人身上；
//     ③ 过期行由 TTL 索引自动清掉，这张表不会长成第二个日志库。
//   生成规则在 controllers/branchAsset.controller.js 的 viewerTag() 一处，别抄第二份。
const mongoose = require("mongoose");
const { ASSET_KINDS } = require("../schemas/branchAsset.schemas");

const branchAssetViewSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ASSET_KINDS, required: true },
    key: { type: String, required: true, trim: true, maxlength: 120 },
    /** 访客标识（见文件头）。★ 不是 IP、不是可逆的东西 */
    viewer: { type: String, required: true, maxlength: 120 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

// 去重的地基：同一访客同一天对同一实体只能有一行（插入撞 11000 = 今天已经数过了）
branchAssetViewSchema.index({ kind: 1, key: 1, viewer: 1 }, { unique: true });
// TTL：到点自动清理（Mongo 的清理线程约每分钟跑一次，延迟删除是正常的）
branchAssetViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("BranchAssetView", branchAssetViewSchema);
