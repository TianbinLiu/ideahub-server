/**
 * AI token 钱包端点。挂在 /api/me/wallet 下，全部需要登录。
 *
 * 钱包本体与三条不变量见 services/tokenWallet.service.js。这一层只做参数校验与限流。
 *
 * ★ 发币的口子**已经不在这里了**。/recharge 与 /plan 曾经是「调一下就到账」的
 *   模拟支付，也就是说有个有效登录态就能给自己发 token。现在两条都改成
 *   **下单**（转 /api/pay/orders），真正发币只发生在渠道回调结算时
 *   —— services/payment/order.service.js 的 applyCallback，那里有幂等与金额校验。
 *   保留这两条路径是为了老客户端不至于直接 404，它们只是转发。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const wallet = require("../services/tokenWallet.service");
const orders = require("../services/payment/order.service");
const { availableChannels } = require("../services/payment/channels");
const { PLANS } = require("../config/tokens");

const router = express.Router();

/** GET /api/me/wallet —— 余额快照。顺带完成初始化与跨月刷新 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const w = await wallet.getWallet(req.user._id);
    if (!w) return res.status(404).json({ ok: false, message: "wallet not found" });
    res.json({ ok: true, wallet: w, plans: PLANS });
  } catch (err) {
    next(err);
  }
});

/** GET /api/me/wallet/ledger —— 最近的 token 流水（"我的钱花哪儿了"） */
router.get("/ledger", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, items: await wallet.listLedger(req.user._id, Number(req.query.limit) || 50) });
  } catch (err) {
    next(err);
  }
});

/**
 * 老路径转下单。
 *
 * ★ 它们**不再发币**了。原来的行为是"调一下就到账"，那是个洞：任何有登录态的人
 *   都能给自己发 token。现在返回一张订单，付款与发币交给 /api/pay。
 * ★ 状态码用 **202 Accepted** 而不是 200：请求收下了、但你要的事（余额变多）
 *   还没发生。老客户端拿 200 会以为充值成功、把余额刷成新的，然后下一次同步又掉回去
 *   —— 静默且全局的错（铁律八）。202 + 明确的 message 至少能让人看出发生了什么。
 */
async function toOrder(req, res, next, make) {
  try {
    const r = await make();
    if (r.error) return res.status(400).json({ ok: false, message: r.error });
    const payable = availableChannels().length > 0;
    res.status(202).json({
      ok: true,
      order: orders.toOrderPayload(r.order),
      payable,
      message: payable
        ? "订单已创建，请完成支付；付款成功后额度会自动到账"
        : "订单已创建，但本服务尚未接入任何支付渠道，暂时无法完成付款",
      // 余额没变，把当前值一并回去，省得客户端为了刷新再打一次
      wallet: await wallet.getWallet(req.user._id),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/me/wallet/recharge —— 【已改为下单】直充包 */
router.post("/recharge", requireAuth, aiRateLimit({ max: 20, scope: "pay-order" }), (req, res, next) =>
  toOrder(req, res, next, () => orders.createRechargeOrder(req.user._id, req.body?.tokens))
);

/** POST /api/me/wallet/plan —— 【已改为下单】购/续套餐 */
router.post("/plan", requireAuth, aiRateLimit({ max: 20, scope: "pay-order" }), (req, res, next) =>
  toOrder(req, res, next, () => orders.createPlanOrder(req.user._id, String(req.body?.planId ?? "")))
);

module.exports = router;
