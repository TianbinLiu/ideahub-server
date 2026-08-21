// src/models/VideoCompose.js
// 成片合并任务的登记表：一条 = 「某一份合并配方的进展」。
//
// 与 ArkVideoTransfer 同一套形状与同一个理由（那边搬 20MB，这边生成 10~30 秒视频，
// 都不是客户端该在线等着的活儿）：
//   · 落库而不是进程内存 —— server 跑在 pm2 cluster 上，客户端两次轮询可能打到不同实例；
//   · 唯一索引当认领锁 —— 同一份配方并发只跑一次（每跑一次都真烧变换配额）；
//   · TTL 48h 自动回收 —— 记录只为"受理→出结果"这一小段生命周期服务。
//
// ★ key = 配方指纹（userId + 段落 + 裁剪 + 尺寸 + 画质 + BGM）。用指纹而不是随机 id，
//   是为了让「用户连点两次合并」「网络重发」天然命中同一条 —— 合并的产物完全由配方决定，
//   同一份配方生成两次只是把同一件事做两遍、多花一份配额和存储。
const mongoose = require("mongoose");

const videoComposeSchema = new mongoose.Schema(
  {
    /** 配方指纹（sha256 前 32 位十六进制）。也是客户端轮询用的 jobId */
    key: { type: String, required: true, trim: true, maxlength: 64 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    state: { type: String, enum: ["pending", "done", "failed"], default: "pending" },
    /** done 时的成片地址（独立资产，不是派生资源 —— 理由见 service 的 materialize） */
    url: { type: String, default: null },
    /** done 时成片的 public_id（发布后回收/管理用） */
    publicId: { type: String, default: null },
    /** failed 时的整句中文原因（客户端原样展示，铁律八） */
    error: { type: String, default: null },
    /** 自检用：期望时长与实测时长。对不上就是踩了静默陷阱，留着可回溯 */
    expectedSec: { type: Number, default: null },
    actualSec: { type: Number, default: null },
    /** 出问题时能照着复现的那串变换（只存变换，不存 host/签名） */
    transform: { type: String, default: null, maxlength: 4000 },
  },
  { timestamps: true, versionKey: false }
);

// 认领锁：一份配方只有一条（插入撞 11000 = 别的请求/实例刚认领，读回来即可）
videoComposeSchema.index({ key: 1 }, { unique: true });
// TTL 兜底回收（48h）
videoComposeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model("VideoCompose", videoComposeSchema);
