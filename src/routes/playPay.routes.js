/**
 * Google Play 结算（D15 阶段 1）。挂在 /api/pay/play（pay.routes.js 末尾）。
 *
 * ★ PLAY_BILLING_ENABLED 没开时整组 404（像不存在一样）：客户端据此判断「这台服务器还不收 Play 的钱」。
 * ★ 服务端只回 code，句子由客户端出（D7 a）。code 表见 docs/api-contract.md「Google Play 结算」。
 * ★ 兑换按**账号**限流：同一个人在两台设备上补单、客户端重试都是正常的，但不该被刷成打 Google API 的放大器。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { playBillingConfig } = require("../config/playBilling");
const play = require("../services/payment/playBilling.service");

const router = express.Router();

// 开关读的是请求那一刻的环境（测试里要能切）；没开就跳出这个 router，落到全局 404
router.use((req, res, next) => (playBillingConfig().enabled ? next() : next("router")));

/** GET /api/pay/play/session —— 下单前拿 obfuscatedAccountId 与商品表 */
router.get("/session", requireAuth, (req, res) => {
  play.sweepInBackground();
  res.json({ ok: true, ...play.sessionOf(req.user) });
});

/** POST /api/pay/play/redeem —— body { purchaseToken, productId } */
router.post("/redeem", requireAuth, aiRateLimit({ max: 30, scope: "play-redeem" }), async (req, res, next) => {
  try {
    const r = await play.redeem(req.user, req.body);
    play.sweepInBackground();
    res.status(r.status).json(r.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
