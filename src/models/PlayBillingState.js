// src/models/PlayBillingState.js
// Google Play 结算的**跨实例**状态（D15 阶段 1）。目前只有一行：voided 清扫的租约与上次跑完的时刻（_id = "voided"）。
//
// ★ 为什么落库、不放内存：生产是 pm2 cluster 双实例，「一天扫一次」放内存会两个实例各扫一次；
//   靠条件更新抢 leaseUntil，同一时刻才只有一个实例在扫（照 TokenOrder.settledAt 的抢占写法）。
const mongoose = require("mongoose");

const playBillingStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    /** 谁拿着租约拿到什么时候；过期即可被别的实例抢走（上一个实例扫到一半挂了也不会永远锁死） */
    leaseUntil: { type: Date, default: null },
    /** 上一次**扫完**的时刻。下一轮从它往前留一天重叠开始查（回收按订单抢 voidedAt，重叠不会重复扣） */
    lastRunAt: { type: Date, default: null },
    /** 上一轮失败的原因（给人看） */
    lastError: { type: String, default: "", maxlength: 500 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PlayBillingState", playBillingStateSchema);
