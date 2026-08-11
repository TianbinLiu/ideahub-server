// src/models/BranchDanmaku.js
// 分支视频弹幕（ideahub-app 首页那条从右往左飘的字）。
//
// ★ 为什么不塞进 BranchComment 多加一个可选字段：两者的语义不同。评论挂在**作品**上、
//   按时间倒序读完就行；弹幕挂在**播放时间轴**上，脱开 `at`（第几秒）它什么都不是。
//   混在一张表里，每个读评论的地方都要去判"这条到底是不是弹幕"，判漏一处评论区里
//   就会冒出一堆没头没尾的短句。
//
// ★ `at` 是**全片累计秒**（多段作品把前面几段的时长加上），与客户端进度条同口径。
//   段内偏移的话，拖到第 2 段弹幕就全乱了。
const mongoose = require("mongoose");

const branchDanmakuSchema = new mongoose.Schema(
  {
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** 出现在全片第几秒 */
    at: { type: Number, required: true, min: 0, max: 86400 },
    /** 正文。40 字是契约里钉死的上限（docs/api-contract.md「弹幕」），客户端同值 */
    text: { type: String, required: true, trim: true, maxlength: 40 },
    /** #rrggbb；缺省 = 白色，由客户端兜底。存的只有"不是默认色"的那些 */
    color: { type: String, default: "" },
  },
  { timestamps: true }
);

// 播放端一次要一整条时间轴：按 video 取、按 at 排。
// 复合索引让「取某条作品的弹幕并按时间轴排序」全程走索引，不做内存排序。
branchDanmakuSchema.index({ video: 1, at: 1 });
// 取"最新的 N 条"（见 controller 的采样说明）走这条
branchDanmakuSchema.index({ video: 1, createdAt: -1 });

module.exports = mongoose.model("BranchDanmaku", branchDanmakuSchema);
