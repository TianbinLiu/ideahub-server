// src/models/GameTicket.js
// 「工坊游戏券」的余额：一条 = 一个账号 × 一个 UTC 月（"YYYY-MM"）。
//
// 设计来源：app 仓 docs/g2-game-ui.md §7 第 1 条、docs/g4-ui-revamp-spec.md §0。
//
// ══ 为什么不塞进 User.tokenWallet ══════════════════════════════════════════════════
//   钱包那张子文档的初始化与刷新是 ensureWallet 一条原子管道；两种币挤在同一条条件更新里，
//   改一处两边都抖（券的月刷新与 token 的日补发 / 月归位是三条不同的规则）。分成一张表之后，
//   「券怎么发、怎么扣、怎么退」全在这个文件的邻居（services/gameTicket.service.js）里，
//   一行都不碰 token 的账（铁律六：一条规则一处实现）。
//
// ══ 字段为什么这么摆 ══════════════════════════════════════════════════════════════
//   balance   **唯一作数的余额**：扣券是一次带条件的 $inc（{ balance: { $gte: 1 } }），
//             与 tokenWallet.debitSplit 同一条「条件原子更新 = 拿到许可」的纪律（W1）。
//             不写成 { granted, earned, used } 再在查询里算余额：余额要是算出来的，
//             「够不够」就得用 $expr 表达（写错不报错、只会多放或少放），而且索引帮不上忙。
//             ★ 不变量（只在 service 里改，别处写库就会出现漂移）：
//               balance = granted + earned - spent + refunded
//   granted   当月**免费套餐那一份**（monthly 来源），一个月恒 ≤ config.MONTHLY_TICKETS
//   earned    「任务加券」与管理员发的（share / invite / admin）
//   spent     这个月花掉几张（**单调递增**，退款不回退它 —— 与 refunded 相减才是「净用了多少」）
//   refunded  失败退回几张（也是单调递增）。★ 分两个单调计数器而不是 `$inc used:-1`：
//             退款可能落到**下个月**（月末最后一发、清扫器隔天才问到失败），$inc 会让新月份的
//             used 变成负数，或者把两个月的账搅在一起。两个计数器相减就没有这个问题。
const mongoose = require("mongoose");

const gameTicketSchema = new mongoose.Schema(
  {
    /** 券是谁的。★★ 扣、退、发都只认这个人（轮询端点不查归属，绝不能"谁问到失败就退给谁"） */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** UTC 月，"YYYY-MM"（写法见 tokenWallet.currentCycle —— 那一处是唯一实现，这里照抄它的值） */
    cycle: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    granted: { type: Number, default: 0, min: 0 },
    earned: { type: Number, default: 0, min: 0 },
    spent: { type: Number, default: 0, min: 0 },
    refunded: { type: Number, default: 0, min: 0 },
    /** 作数的余额（文件头 ★：扣券的条件就写在这个字段上） */
    balance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

// 一个账号一个月一行。★ 唯一索引同时是**并发发放的锁**：两个实例同时懒发月度券时，
// 只有建得成的那一方往下走（抢不到的那一方读回同一行，见 gameTicket.service.ensureRow）。
gameTicketSchema.index({ userId: 1, cycle: 1 }, { unique: true });

// ★ 表名写死成 gametickets（设计稿 §7 第 1 条点名了这个集合名；mongoose 默认也是复数，
//   但显式写出来免得哪天被全局 plugin 改成别的）
const GameTicket = mongoose.model("GameTicket", gameTicketSchema, "gametickets");
module.exports = GameTicket;
