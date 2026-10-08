// src/models/GenTaskCharge.js
// 一发**已经扣了钱、上游也受理了**的异步生成任务的「账」：一条 = 一个上游任务号（方舟 cgt-… / MiniMax task_id）。
// 失败退款（2026-10-07 主人拍板「做生成失败返回 token」）的唯一实现在 services/taskRefund.service.js，这张表是它的底账。
//
// ══ 为什么要单开一张表，而不是在 ArkVideoTask / BlockoutJob 上加几个字段 ════════════
//   · 那两张表**都不记钱**：扣了多少、从哪一桶扣的（plan / addon）、是不是管理员免单 —— 退款要的恰恰是这三样；
//   · 覆盖面不同：ArkVideoTask 只记 Seedance、BlockoutJob 只记白模化，Seed3D 与 MiniMax 根本没有登记处；
//   · 寿命不同：ArkVideoTask 48 小时、BlockoutJob 24 小时 + 墓碑，而一发任务要等**结出来**（退了 / 成了 / 放弃了）
//     才能删 —— 用它们的 TTL 的话，方舟在第 48 小时报 expired 的那一刻，登记先被 Mongo 删了，钱就退不回去了。
//   所以「找回凭据」「取件单」「钱」各管各的：这张表只管钱，四条出片路（/api/ark 代理、白模化、MiniMax、Seed3D）共用。
//
// ══ 恰好退一次（两个 pm2 实例 + 清扫器 + 白模化取回 + 任何人的轮询，可能同时看见同一个失败）══
//   state 是一台只往前走的状态机，每一步都是**条件原子更新**：
//     open ──(上游明说失败，抢占)──▶ claimed ──(钱进了钱包)──▶ refunded
//       ├──(上游明说成功)──────────▶ settled
//       ├──(免单 / 一分没扣)────────▶ skipped（落库那一拍就定，不再问上游）
//       └──(8 天还问不出结局)───────▶ lost（吼一嗓子，人工处理）
//   只有把 open 抢成 claimed 的那一方去动钱；崩在 claimed 上的由清扫器按**账本 memo** 判断钱进没进过（remixReward 同一招）。
//
// ★ TTL 只挂在**结完了**的行上（purgeAt 只在终态写）：open / claimed 的行一行都不会被 Mongo 悄悄删掉 ——
//   那就是"钱没退、证据也没了"。终态之后留 30 天给对账与客服查。
const mongoose = require("mongoose");

/** 结局之后留多久（对账 / 客服查「那一发退了没有」用）。只在终态写 purgeAt */
const KEEP_AFTER_SETTLE_MS = 30 * 24 * 60 * 60 * 1000;

const STATES = ["open", "claimed", "refunded", "settled", "skipped", "lost"];
// video      Seedance 普通出片（含 r2v、返修、延长、素材参考 —— 都走 /api/ark 代理那一条）
// draft      电影级样片第一步（draft:true，480p）
// draftFinal 电影级样片第二步（样片 → 1080p 成片）。★ 两步是两笔独立的钱，各退各的（第一步成了、第二步失败只退第二步）
// 3d         Seed3D 图生 3D
// blockout   白模化（服务端自己发的那一发 r2v）。★ 它退钱时还要把 BlockoutJob 一起钉成 failed（见 taskRefund.service）
// minimax    真人档（MiniMax）
const KINDS = ["video", "draft", "draftFinal", "3d", "blockout", "minimax"];

const genTaskChargeSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["ark", "minimax"], required: true },
    /** 上游任务号。已过各自路由的 TASK_ID_RE 收口（只有安全字符） */
    taskId: { type: String, required: true, trim: true, maxlength: 64 },
    kind: { type: String, enum: KINDS, required: true },
    /** 钱是谁的。★★ 退款**只**退给这个人 —— 轮询端点不查归属（任何登录用户都能问任何任务号），
     *  所以绝不能"谁问到失败就退给谁" */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    model: { type: String, default: "", maxlength: 80 },
    /** 实扣多少（管理员免单记 0）。与 took 两桶之和恒等 */
    charged: { type: Number, required: true, min: 0 },
    /**
     * 这一笔是从哪一桶扣的（tokenWallet.debitSplit 的扣前快照算出来的，精确到个位）。
     * ★★ 退款按原桶退回：plan 的那部分回 plan、addon 的那部分回 addon。全进 addon 的话，
     *   免费版只要反复提交"输入过审、输出不过审"的提示词，就能把会过期的 plan 洗成永不过期的 addon。
     */
    took: {
      plan: { type: Number, default: 0, min: 0 },
      addon: { type: Number, default: 0, min: 0 },
    },
    /** 管理员免单（受理那一刻的身份，不是现在的：退款时这个人可能已经不是管理员了） */
    free: { type: Boolean, default: false },
    /** 扣费流水的 memo 原样（对账时把「扣」和「退」对上） */
    memo: { type: String, default: "", maxlength: 200 },
    /** MiniMax 的任务绑区域（cn / intl）：清扫器只能回同一个站、用同一把 key 去问 */
    region: { type: String, default: undefined, maxlength: 8 },
    state: { type: String, enum: STATES, default: "open" },
    /** skipped / lost 的原因（给人查的，不上屏）：free / zero / user_gone / refund_off / too_old */
    note: { type: String, default: "", maxlength: 60 },
    /** 上游最后一次明说的状态与错误码（failed 的 OutputVideoSensitiveContentDetected 之类），对账与客服用 */
    upstreamStatus: { type: String, default: "", maxlength: 32 },
    upstreamCode: { type: String, default: "", maxlength: 80 },
    /** 实退多少（refunded 才有） */
    refundedTokens: { type: Number, default: 0 },
    /** 抢到 claimed 的时刻（判"这个 claimed 是不是搁浅了"） */
    claimedAt: { type: Date, default: null },
    /** 走到终态的时刻 */
    settledAt: { type: Date, default: null },
    /** 清扫器下一次该问上游的时刻（open 才有意义；问不出结局就往后退避） */
    nextCheckAt: { type: Date, default: null },
    /** 清扫器问过上游几次（退避用） */
    checks: { type: Number, default: 0 },
    /**
     * 退款之后的收尾做完了没有：① 白模化那一发要把 BlockoutJob 钉成 failed（带退款的那句话）；
     * ② 钱是在**本人自己那次轮询之外**退的（清扫器、别人轮询、并发的另一发）就发一条站内通知。
     * ★ 为什么非发不可：App 里没有流水页 —— 一笔说不出来历的余额变动比一条通知糟（remixReward.notify 同一条理由）。
     *   本人轮询的响应里已经带着 `refund` 了，那一次就不再发通知（说两遍是噪音）。
     */
    notified: { type: Boolean, default: false },
    /** TTL：只在终态写（见文件头 ★） */
    purgeAt: { type: Date, default: undefined },
  },
  { timestamps: true, versionKey: false },
);

// 一个上游任务只记一笔账（两家的任务号是两个命名空间）
genTaskChargeSchema.index({ provider: 1, taskId: 1 }, { unique: true });
// 清扫器：到点该问的 open 行 / 搁浅的 claimed 行 / 收尾没做完的 refunded 行
genTaskChargeSchema.index({ state: 1, nextCheckAt: 1 });
genTaskChargeSchema.index({ state: 1, notified: 1 });
// 只回收结完了的行（open / claimed 没有 purgeAt，TTL 线程不碰它们）
genTaskChargeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

const GenTaskCharge = mongoose.model("GenTaskCharge", genTaskChargeSchema);
GenTaskCharge.STATES = STATES;
GenTaskCharge.KINDS = KINDS;
GenTaskCharge.KEEP_AFTER_SETTLE_MS = KEEP_AFTER_SETTLE_MS;
module.exports = GenTaskCharge;
