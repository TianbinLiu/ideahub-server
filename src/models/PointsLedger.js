// src/models/PointsLedger.js
// 虚拟点数账本 —— 每一条都是一次【记账分录】。只追加，不更新、不删除。
//
// ★点数是平台虚拟点数，不是真钱：不涉及任何真实支付/提现/兑换。
//
// ── 三条硬不变量（写这个模型的人必须先看懂）─────────────────────────
// 【I1 只有注册赠送能印钱】除 reason="signup" 外，每一次点数变动都必须【成对】写账且【和为零】。
//    可机检的对账式：sum(所有 delta) === sum(所有 signup 的 delta)。
//    → 所以除 signup 外一律走 points.service 的 writeTransferEntries()，别在别处单独 create 一条。
// 【I2 并发不超付】扣减/发放一律用条件原子更新，严禁读-改-写。
// 【I3 退款幂等】关闭悬赏退还托管只能退一次（见 Bounty.refundedAt）。
//
// ── user 为 null 是什么意思 ──────────────────────────────────────
// user:null 表示这笔分录挂在【该悬赏的托管账户】上（平台内部账，不属于任何人）。
// 某个悬赏的托管余额 = 该 bounty 下所有 user:null 分录的 delta 之和，
// 它必须恒等于 Bounty.escrowPoints（那是同一个数的、可做条件原子更新的镜像）。
// ★托管分录【不得】出现在任何用户的流水接口里。
const mongoose = require("mongoose");

const LEDGER_REASONS = ["signup", "bounty_hold", "bounty_reward", "bounty_refund"];

const pointsLedgerSchema = new mongoose.Schema(
  {
    // null = 悬赏的托管账户（不是某个用户）
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // signup 时为空
    bounty: { type: mongoose.Schema.Types.ObjectId, ref: "Bounty", default: null },
    // 正 = 入账，负 = 出账
    delta: { type: Number, required: true },
    reason: { type: String, enum: LEDGER_REASONS, required: true },
    // 仅 user 非 null 的分录记录，便于事后对账排查（托管账户没有"余额快照"这一说）
    balanceAfter: { type: Number, default: null },
    memo: { type: String, default: "" },
  },
  { timestamps: true }
);

pointsLedgerSchema.index({ user: 1, createdAt: -1 });
pointsLedgerSchema.index({ bounty: 1 });

// ★注册赠送幂等的最后一道闸：同一个 user 只可能有一条 signup 分录。
// 靠代码"先查再插"挡不住并发（两个请求同时查不到、同时插入），必须由唯一索引在库层面挡。
// partialFilterExpression 让约束只作用于 signup，其它 reason 不受影响（同一人当然会有多条 hold/reward）。
pointsLedgerSchema.index(
  { user: 1, reason: 1 },
  { unique: true, partialFilterExpression: { reason: "signup" } }
);

module.exports = mongoose.model("PointsLedger", pointsLedgerSchema);
module.exports.LEDGER_REASONS = LEDGER_REASONS;
