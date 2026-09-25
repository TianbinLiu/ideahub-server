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
// refunded 渠道退款/拒付后把已发的 token 收回来了（终态；Play 的 voidedpurchases）
const ORDER_STATUSES = ["created", "paid", "settled", "closed", "failed", "refunded"];

const tokenOrderSchema = new mongoose.Schema(
  {
    /** 商户订单号，服务端生成，全局唯一。回调认这个号 */
    orderNo: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
    /**
     * 下单人。★ **允许为空**：Play 的退款通知可能**先于**兑换到达，那一刻我们还不知道
     * 是谁买的，但必须先把这个 purchaseToken 占位标成已回收，兑换那一步才拒得掉（P1）。
     */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
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

    // ── Google Play（channel="play"）────────────────────────────────
    /**
     * Play 的 purchaseToken。**这是这条链路的幂等键**：同一个 token 只能兑一次，
     * 靠下面那条唯一索引在并发时撞死，而不是靠「先查再写」。
     * ★ sparse/partial：其它渠道的订单没有这个字段，不能让它们互相撞。
     */
    playPurchaseToken: { type: String, default: undefined, trim: true, maxlength: 512 },
    /** Play 侧的订单号（GPA.xxxx），对账时人眼要看的那个 */
    playOrderId: { type: String, default: "", trim: true, maxlength: 128 },
    /** 一次买了几份（Play 允许多买）。**回收按比例时的分母取这里的快照**，不回头查 API */
    quantity: { type: Number, default: 1, min: 1 },
    /** 许可测试员的购买。★ 所有营收/成本统计必须排除；退款时差额不转欠额 */
    isTest: { type: Boolean, default: false },
    /**
     * 真正发币完成的时间。**与 settledAt 分开**：settledAt 是「抢到了结算权」，
     * grantedAt 是「币确实发了」。崩在两者之间时，清扫器靠这个差别知道要补发；
     * 回收也靠它判断「现在回收会不会把欠额算成 0」（R-5 的推迟）。
     */
    grantedAt: { type: Date, default: null },
    /** 落单时存下的商品 id。清扫器重试 consume 要用它（raw 里那份藏在数组第二层） */
    playProductId: { type: String, default: "", trim: true, maxlength: 128 },
    /** consume（对可消耗商品同时完成 acknowledge）成功的时间 */
    consumedAt: { type: Date, default: null },
    /**
     * consume 试了几次、最后一次什么时候。
     * ★★ 不是装饰：Play 对可消耗商品「3 天未 acknowledge 自动退款」，而 consume 蕴含
     *   acknowledge。没有这两个字段，「试了多少次、还要不要继续试、是不是该告警」在事后
     *   完全看不出来 —— 而这条链路失败时是**静默**的（consume 只 console.error）。
     */
    consumeAttempts: { type: Number, default: 0, min: 0 },
    consumeLastAt: { type: Date, default: null },
    /** 回收的幂等锚（与 settledAt 同构）：抢到 null → now 的那一次才真的回收 */
    revokedAt: { type: Date, default: null },
    /** 实际收回多少 token */
    clawbackTokens: { type: Number, default: 0, min: 0 },
    /** 收不回的差额（转成了钱包欠额；isTest 时豁免） */
    shortfall: { type: Number, default: 0, min: 0 },
    /** 部分退款时被作废的份数 */
    voidedQuantity: { type: Number, default: 0, min: 0 },
    /** Play 的 voidedSource/voidedReason 原值。⚠ 官方没有定义取值含义，只存备查、不据此分支 */
    refundType: { type: String, default: "", trim: true, maxlength: 64 },

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
// Play 的幂等键。partial 过滤掉没有这个字段的其它渠道订单（否则它们会在 null 上互撞）
tokenOrderSchema.index(
  { playPurchaseToken: 1 },
  { unique: true, partialFilterExpression: { playPurchaseToken: { $type: "string" } } }
);

module.exports = mongoose.model("TokenOrder", tokenOrderSchema);
module.exports.ORDER_KINDS = ORDER_KINDS;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
