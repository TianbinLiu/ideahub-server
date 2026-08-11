// 充值订单：下单、结算、关闭。
//
// ★★ 这个文件盯着三条不变量。三条都是「做错了不报错、只会多发或少发 token」的那种，
//    所以每条都在 tests/payOrder.spec.js 里有对应用例：
//
//    O1  一笔订单只发一次币。
//        支付回调**必然会重复**（渠道重试、运维手动重推、网络抖动导致的补发）。
//        靠 status 判"处理过没有"是不够的：读到 paid 再写 settled 中间隔着一个
//        并发窗口，两条回调同时进来就发两次。这里用**条件原子更新**抢
//        `settledAt: null → now`，只有抢到的那一条才真的 credit。
//
//    O2  金额以订单为准，回调只用来确认"付了"。
//        商品、价格、数量全部读订单里下单那一刻的快照，绝不读回调体里的同名字段
//        ——那是外部输入。实付金额少于应付时不发币（渠道侧改价/部分退款都可能造成）。
//
//    O3  未注册的渠道一律拒绝。
//        没有 adapter 就没有验签。把未知渠道当成功处理，等于任何人 POST 一下
//        就能白拿 token。这条在 routes 层挡（channelOf 返回 null 即 400）。
const crypto = require("crypto");
const TokenOrder = require("../../models/TokenOrder");
const wallet = require("../tokenWallet.service");
const { planOf } = require("../../config/tokens");
const { ORDER_TTL_MIN } = require("../../config/payment");

/**
 * 直充包目录。★ 只收在册面额，不收任意数字 —— 否则"充 999999999"就是一句话的事。
 *
 * ★★ 这三行的价必须和 **app 仓 `src/data/economy.ts` 的 RECHARGE_PACKS 逐条相等**。
 *   那边是【报价】（按下按钮前给用户看的），这边是【结算】（真扣钱的）。
 *   对不上就是"页面写 ¥25、扣了 ¥15"——用户会觉得被偷了钱，而且两个数都对不上账。
 *   跨仓契约，改任何一条两边一起改（docs/api-contract.md）。
 *   金额一律整数分：用元记浮点，0.1+0.2 那类误差会直接变成对账差额。
 */
const RECHARGE_PACKS = [
  { tokens: 200_000, amountFen: 600 }, // ¥6
  { tokens: 1_000_000, amountFen: 2500 }, // ¥25
  { tokens: 5_000_000, amountFen: 9800 }, // ¥98
];

function packOf(tokens) {
  return RECHARGE_PACKS.find((p) => p.tokens === Number(tokens)) ?? null;
}

/**
 * 商户订单号。时间前缀便于人肉排查，后面接 12 字节随机。
 * ★ 不用自增，也不用可预测的用户 id + 时间戳：订单号会出现在回调 URL 和对账单里，
 *   可预测意味着别人能猜出你的订单号去试探（mock 渠道下就是直接发币）。
 */
function newOrderNo() {
  const t = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `IH${t}${crypto.randomBytes(9).toString("hex")}`;
}

/** 下单：直充包 */
async function createRechargeOrder(userId, tokens) {
  const pack = packOf(tokens);
  if (!pack) return { error: "unknown recharge pack" };
  const order = await TokenOrder.create({
    orderNo: newOrderNo(),
    user: userId,
    kind: "recharge",
    packTokens: pack.tokens,
    amountFen: pack.amountFen,
  });
  return { order };
}

/** 下单：套餐 */
async function createPlanOrder(userId, planId) {
  const plan = planOf(planId);
  if (plan.id !== planId) return { error: "unknown plan" };
  if (plan.price <= 0) return { error: "plan is free, no order needed" };
  const order = await TokenOrder.create({
    orderNo: newOrderNo(),
    user: userId,
    kind: "plan",
    planId: plan.id,
    amountFen: Math.round(plan.price * 100),
  });
  return { order };
}

/** 订单是不是已经超时了（created 状态下超过 TTL 就不该再收款） */
function isExpired(order) {
  if (order.status !== "created") return false;
  return Date.now() - new Date(order.createdAt).getTime() > ORDER_TTL_MIN * 60_000;
}

/**
 * 处理一次渠道回调的确认结果，必要时发币。
 *
 * @param {object} v adapter.verify 的返回：{ orderNo, channelTxnId, paidFen, failed, raw }
 * @param {string} channel 渠道名
 * @returns {Promise<{ ok: boolean, code: string, order?: object }>}
 *
 * code 取值（都是给日志和渠道应答用的，不直接给用户看）：
 *   settled      本次真的发了币
 *   duplicate    这笔订单之前已经结算过（重复回调，正常现象，要回 ok）
 *   underpaid    实付少于应付，不发币
 *   expired      订单已超时/已关闭
 *   not_found    订单号不存在
 *   marked_failed 渠道明确告知失败
 */
async function applyCallback(channel, v) {
  const order = await TokenOrder.findOne({ orderNo: String(v.orderNo || "") });
  if (!order) return { ok: false, code: "not_found" };

  // 渠道说这笔失败了：记下来，终态，不发币
  if (v.failed) {
    if (!order.settledAt) {
      order.status = "failed";
      order.channel = channel;
      order.raw = v.raw;
      order.note = "渠道回报支付失败";
      await order.save();
    }
    return { ok: true, code: "marked_failed", order };
  }

  // O1：已经发过币 —— 重复回调走这里。要回 ok，否则渠道会一直重推
  if (order.settledAt) return { ok: true, code: "duplicate", order };

  if (order.status === "closed" || isExpired(order)) {
    return { ok: false, code: "expired", order };
  }

  // O2：金额以订单为准。实付不足不发币（部分退款、渠道侧改价都会走到这）
  const paidFen = Number(v.paidFen || 0);
  if (paidFen < order.amountFen) {
    order.status = "failed";
    order.channel = channel;
    order.paidFen = paidFen;
    order.raw = v.raw;
    order.note = `实付 ${paidFen} 分少于应付 ${order.amountFen} 分`;
    await order.save();
    return { ok: false, code: "underpaid", order };
  }

  // ★ O1 的落点：条件原子更新抢 settledAt。两条回调同时进来时只有一条能把
  //   `settledAt: null` 改成 now，另一条的 matchedCount 为 0 —— 那条就是重复。
  //   注意条件里同时锁死 orderNo 和 settledAt: null，缺一不可。
  const now = new Date();
  const claim = await TokenOrder.updateOne(
    { _id: order._id, settledAt: null },
    {
      $set: {
        settledAt: now,
        status: "paid", // 币还没发，先标 paid；发完下面再改 settled
        channel,
        channelTxnId: String(v.channelTxnId || ""),
        paidFen,
        paidAt: now,
        raw: v.raw,
      },
    }
  );
  if (claim.matchedCount === 0) {
    return { ok: true, code: "duplicate", order: await TokenOrder.findById(order._id) };
  }

  // 抢到了，发币。读的是**订单里的快照**，不是回调体，也不是当前价目表
  const granted = await grantForOrder(order);

  const settled = await TokenOrder.findByIdAndUpdate(
    order._id,
    { $set: { status: "settled", grantedTokens: granted } },
    { returnDocument: "after" }
  );
  return { ok: true, code: "settled", order: settled };
}

/**
 * 按订单快照发币，返回实发数量。
 * ★ 直充进 addon（永不过期），套餐进 plan（跨月作废）—— 与 tokenWallet 的口径一致。
 */
async function grantForOrder(order) {
  if (order.kind === "recharge") {
    await wallet.credit(order.user, order.packTokens, "recharge", `订单 ${order.orderNo}`);
    return order.packTokens;
  }
  const w = await wallet.buyPlan(order.user, order.planId);
  return w ? planOf(order.planId).monthlyTokens : 0;
}

/** 关单（用户取消/超时清理）。已结算的订单不能关 */
async function closeOrder(orderNo, userId, note = "") {
  const r = await TokenOrder.findOneAndUpdate(
    { orderNo, user: userId, settledAt: null, status: "created" },
    { $set: { status: "closed", note: note || "已关闭" } },
    { returnDocument: "after" }
  );
  return r;
}

/** 对外的订单视图。★ raw 是渠道原文，可能含渠道侧的用户标识，不给客户端 */
function toOrderPayload(o) {
  if (!o) return null;
  return {
    orderNo: o.orderNo,
    kind: o.kind,
    packTokens: o.packTokens || undefined,
    planId: o.planId || undefined,
    amountFen: o.amountFen,
    currency: o.currency,
    status: o.status,
    channel: o.channel || "",
    grantedTokens: o.grantedTokens || 0,
    paidAt: o.paidAt || null,
    settledAt: o.settledAt || null,
    createdAt: o.createdAt,
    expiresInMin: ORDER_TTL_MIN,
  };
}

module.exports = {
  RECHARGE_PACKS,
  packOf,
  newOrderNo,
  createRechargeOrder,
  createPlanOrder,
  applyCallback,
  closeOrder,
  isExpired,
  toOrderPayload,
};
