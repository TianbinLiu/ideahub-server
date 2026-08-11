// src/models/TokenOrder.js
// 充值订单 —— 「用户付了多少钱」与「我们发了多少 token」之间的那一层。
//
// ★ 为什么必须有这层，而不是收到回调直接发币：
//   支付渠道的回调是**会重复的**（网络重试、渠道主动补发、运维手动重推），
//   而且到达顺序不保证。没有订单实体时，"这条回调是不是已经处理过了"根本无从判断，
//   于是同一笔钱可能发两次币。订单把它变成一个可判定的问题：
//   一笔订单只有一个 orderNo，发币这件事在它身上只能发生一次（见 settledAt）。
//
// ★ 金额一律用**整数分**（amountFen）。用元记浮点，0.1+0.2 那类误差会直接变成对账差额。
//
// ★ 商品信息在下单那一刻**快照**进订单（packTokens / planId / amountFen）。
//   结算时只读订单里的快照，不读当前价目表 —— 否则改价会影响到已经付过钱的老订单。
const mongoose = require("mongoose");

const ORDER_KINDS = ["recharge", "plan"];
// created  已下单，等待付款
// paid     渠道回调确认已付款（此时还没发币）
// settled  已发币，终态
// closed   已关闭（超时未付/用户取消），终态
// failed   渠道明确告知支付失败，终态
const ORDER_STATUSES = ["created", "paid", "settled", "closed", "failed"];

const tokenOrderSchema = new mongoose.Schema(
  {
    /** 商户订单号，服务端生成，全局唯一。回调认这个号 */
    orderNo: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ORDER_KINDS, required: true },

    // ── 商品快照 ──
    /** kind=recharge：这一单买多少 token */
    packTokens: { type: Number, default: 0, min: 0 },
    /** kind=plan：买的是哪个套餐 */
    planId: { type: String, default: "", trim: true, maxlength: 40 },
    /** 应付金额（分） */
    amountFen: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "CNY", trim: true, maxlength: 8 },

    status: { type: String, enum: ORDER_STATUSES, default: "created", index: true },

    // ── 渠道侧 ──
    /** 支付渠道标识（wechat / alipay / mock…）。下单时可能还没定，回调时必然有 */
    channel: { type: String, default: "", trim: true, maxlength: 32 },
    /** 渠道流水号。★ 与 orderNo 一起做唯一约束，防止同一笔渠道流水被塞给两张订单 */
    channelTxnId: { type: String, default: "", trim: true, maxlength: 128 },
    /** 渠道回报的实付金额（分）。与 amountFen 比对，少付不发币 */
    paidFen: { type: Number, default: 0, min: 0 },
    paidAt: { type: Date, default: null },

    /**
     * 发币完成的时间戳。**这是幂等的锚点**：
     * 结算走的是「条件更新 settledAt: null → now」，只有抢到那一次的请求才真的 credit。
     * 重复回调进来时条件不成立，直接返回"已处理"。
     * 用它而不是 status：status 是给人看的，多一个中间态就可能被别处改写；
     * 这个字段只有结算那一处会写。
     */
    settledAt: { type: Date, default: null },
    /** 实际发放的 token（审计用，正常等于 packTokens 或套餐月额度） */
    grantedTokens: { type: Number, default: 0, min: 0 },

    /** 回调原文。出对账纠纷时唯一能自证的东西，不做裁剪 */
    raw: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /** 失败/关闭的原因，给人看 */
    note: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// 同一渠道下的流水号唯一：渠道把同一笔支付回调给两张不同订单时在这里撞死。
// 老数据与未回调的订单 channelTxnId 是空串，partial 过滤掉它们
tokenOrderSchema.index(
  { channel: 1, channelTxnId: 1 },
  { unique: true, partialFilterExpression: { channelTxnId: { $type: "string", $gt: "" } } }
);
tokenOrderSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("TokenOrder", tokenOrderSchema);
module.exports.ORDER_KINDS = ORDER_KINDS;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
