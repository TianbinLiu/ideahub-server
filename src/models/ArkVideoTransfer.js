// src/models/ArkVideoTransfer.js
// 方舟成片 → Cloudinary 永久地址的**转存登记**：一条 = 「某个方舟产物的转存进展」。
//
// 为什么要落库而不是进程内存：server 跑在 pm2 cluster 多实例上，客户端的两次轮询
// 可能打到不同实例——内存表会让"谁在搬 / 搬完了没有"各实例各说各话，同一个产物被
// 重复下载上传（20MB×2 的带宽 + 双份 Cloudinary 存储），pending 还可能在另一个实例
// 眼里永远不落地。Mongo 的唯一索引正好当认领锁用（与 BranchTemplateTrial 同一思路：
// 证据/状态放所有实例都看得见的地方）。
//
// ★ sourceKey 是 `协议//主机/路径`（**不含 query**）：TOS 的签名参数每次轮询都可能
//   重签，整串 URL 当身份的话，同一个产物在"轮询自动转存"与"老客户端自己 POST"
//   两条路上会各算一份，去重就废了。下载仍用带签名的完整 sourceUrl（首见那份）。
// ★ TTL 48h：方舟产物链接本身 24h 就过期，转存要么早就出结果、要么已经永远做不成，
//   过期自动清掉，不用任何人惦记回收（同 BranchTemplateTrial 的取舍）。
const mongoose = require("mongoose");

const arkVideoTransferSchema = new mongoose.Schema(
  {
    /** 产物身份：协议//主机/路径，不含 query（见文件头 ★） */
    sourceKey: { type: String, required: true, trim: true, maxlength: 2000 },
    /** 实际下载用的完整签名地址（首见那份；重试时会换成新一份） */
    sourceUrl: { type: String, required: true, trim: true, maxlength: 4000 },
    state: { type: String, enum: ["pending", "done", "failed"], default: "pending" },
    /** done 时的 Cloudinary 永久地址 */
    url: { type: String, default: null },
    /** failed 时的原因（服务端口径，客户端可原样展示） */
    error: { type: String, default: null },
    /** 触发转存的用户（只用于 Cloudinary public_id 前缀，不做权限判断——
     *  产物地址本身就是凭据，谁轮询到都该拿到同一份转存结果） */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false }
);

// 认领锁：一个产物只有一条（插入撞 11000 = 别的请求/实例刚认领，读回来即可）
arkVideoTransferSchema.index({ sourceKey: 1 }, { unique: true });
// TTL 兜底回收（48h）
arkVideoTransferSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model("ArkVideoTransfer", arkVideoTransferSchema);
