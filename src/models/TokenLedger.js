// src/models/TokenLedger.js
// AI token 流水 —— 每一条是一次余额变动。只追加，不更新、不删除。
//
// ★ 这【不是】 PointsLedger 那种复式记账，别照那边的不变量来读。
//   点数是用户之间转移的（所以要求"除注册赠送外每笔和为零"）；
//   token 是**对外采购的算力**：印钱口是充值/购套餐（模拟支付），
//   销毁口是花在方舟上——没有对手方，配不成对。
//   于是这里只做**审计流水**：出了"余额怎么少了这么多"的疑问时能逐笔查回去，
//   退款有没有真退也能对得上。
//
// ★ balanceAfter 记的是变动后的 plan+addon 总额（快照）。它是冗余的，
//   但正是"账本和余额对不对得上"的唯一抓手：只有余额、没有流水时，
//   多扣一笔和少退一笔在事后完全无法区分。
const mongoose = require("mongoose");

// grant       注册/首次触达发的免费额度
// recharge    直充进 addon（模拟支付）
// plan_buy    购/续套餐发放 plan 额度（模拟支付）
// cycle_reset 月度刷新（plan 归位到当月额度，未用完的作废）—— delta 可正可负
// ark_spend   花在方舟上（负）
// ark_refund  方舟没受理，把 ark_spend 退回来（正）
// admin_free  管理员免单的方舟调用：**余额不动（delta=0），但这笔钱真花出去了**，
//             实际金额记在 costTokens 里。见下面 costTokens 的说明与
//             services/tokenWallet.service.js 的 noteAdminFree。
// play_refund    渠道退款把已发的 token 收回来（负）
// debt_incurred  收回时余额不够，差额转成欠额：**余额不动（delta=0）**，差额记在 costTokens
// debt_repaid    下次充值抵扣欠额（负）
// debt_forgiven  管理员免除欠额（delta=0，金额记 costTokens）
// provider_failed 上游受理后才失败、按政策退回的那一类（与 ark_refund 分开，便于对账）
// ★★ 这是 **mongoose enum**：没注册的 reason 会写入失败，而 writeEntry 把异常吞进
//    console.error —— 表现是「回收做了、账本静默缺条」。加新 reason 必须先加这里。
const TOKEN_REASONS = [
  "grant",
  "recharge",
  "plan_buy",
  "cycle_reset",
  "ark_spend",
  "ark_refund",
  "admin_free",
  "play_refund",
  "debt_incurred",
  "debt_repaid",
  "debt_forgiven",
  // MiniMax 真人档未受理时的退款。⚠ 它从 2026-08 就在 `minimax.routes.js` 里当 refundTag 传了，
  //   却一直不在这张 enum 里 —— 于是余额 $inc 成功、账本那条撞 enum 被上面那个 catch 吞掉，
  //   表现正是这个文件注释警告的「账本静默缺条」。2026-09-25 评审逮到。
  //   ★ 加进 enum **只修了一半**：`spentToday` 的 $in 里也要有它，否则退款抵不掉当日用量，
  //   免费档被敏感词拒两次就被日上限锁到次日，而余额栏还显示满格。
  "minimax_refund",
  // ⚠ 目前**没有任何写入方**：受理之后才失败的那一类我们**不退**（见 billing.service 的 W2），
  //   留着这个取值是为了将来真要区分时有地方落。别照它的字面意思去实现「失败就退」。
  "provider_failed",
];

const tokenLedgerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** 正 = 入账，负 = 出账 */
    delta: { type: Number, required: true },
    reason: { type: String, enum: TOKEN_REASONS, required: true },
    /** 变动后的 plan + addon 总额 */
    balanceAfter: { type: Number, default: null },
    /** ark_spend / ark_refund 记是哪个端点、哪个模型，便于事后核对定价 */
    memo: { type: String, default: "" },
    /**
     * 这次调用**值多少钱**（token），与"扣了多少"（delta）是两件事。
     *
     * ★ 目前只有 admin_free 用它：管理员免单时 delta 记 0（余额确实没动），
     *   金额照实记在这里。两个问题就都答得上来了 ——
     *     "余额对不对" 逐笔累加 delta 与 balanceAfter 对照；
     *     "钱花到哪去了" 把 ark_spend 的 |delta| 与 admin_free 的 costTokens 加起来，
     *      才是方舟账单上那个数。
     * ★ 为什么不干脆把 admin_free 的 delta 记成 -cost：那会让账本凭空比余额少一大截，
     *   而 balanceAfter 存在的唯一理由就是"账本和余额对得上"。真出了"我的钱怎么少了"
     *   的疑问时，一堆对不上的行会把真问题彻底淹掉。
     * ★ 老数据没有这一列（undefined）。读的时候按"没有"处理，别把它当 0 参与求和之外的判断。
     */
    costTokens: { type: Number, default: undefined },
    /**
     * 这一笔来自**测试购买**（Play 许可测试员）。所有营收 / 成本统计必须排除它，
     * 否则测试员刷几次就把月报打成一条不存在的曲线。老数据没有这一列（undefined = 不是测试）。
     */
    isTest: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);

tokenLedgerSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("TokenLedger", tokenLedgerSchema);
module.exports.TOKEN_REASONS = TOKEN_REASONS;
