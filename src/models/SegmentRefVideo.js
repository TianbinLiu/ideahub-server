// src/models/SegmentRefVideo.js
// 「本人成片当参考视频」的时长缓存（2026-10-05，App「修这一段」：返修 / 片段重拍 / 延长）。
//
// ★★ 为什么要有它：resolveR2v 只认「服务端自己知道时长的视频」—— 带视频输入的任务按
//   (输入时长 + 输出时长) 计价，输入多长不能信客户端（同 BranchTemplate / MaterialRefVideo 的理由）。
//   本人成片住在 Cloudinary `ideahub/branch-videos/<userId>-<毫秒>-seg`（出片即转存的产物），时长只能问
//   Cloudinary Admin API；而免费档 Admin API 是**全局** 500 次/小时 —— 每发返修 / 延长都现查一次的话，
//   几个人连着点就能把建模板也一起刷停（routes/ark.routes 的 limitUnregisteredR2v 那条 ★ 同一个理由）。
//   所以查过一次就记在这里，同一段再用直接读。
// ★ 归属**不靠这张表判**：每一发都先过 utils/videoCompose.parseOwnBranchVideoUrl（文件名以本人 id 开头），
//   这里只缓存「这段视频多长、多大」—— 表被谁写坏了也越不过归属那道门。
// ★ TTL 24 小时：成片会被回收（删草稿 / 删作品的资产清扫）。缓存活得比文件久的话，方舟拿不到参考视频是
//   **受理之后**的异步失败（钱已经扣了）；一天重查一次，把这个窗口压到一天以内。
const mongoose = require("mongoose");

const segmentRefVideoSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Cloudinary public_id（`ideahub/branch-videos/<userId>-<毫秒>-<后缀>`，已过归属判据） */
    publicId: { type: String, required: true, trim: true, maxlength: 300 },
    /** 服务端从 Cloudinary 取回的时长（秒，小数）。计价输入，客户端不可写 */
    durationSec: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
  },
  { timestamps: true, versionKey: false },
);

segmentRefVideoSchema.index({ publicId: 1 }, { unique: true });
segmentRefVideoSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model("SegmentRefVideo", segmentRefVideoSchema);
