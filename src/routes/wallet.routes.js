/**
 * AI token 钱包端点。挂在 /api/me/wallet 下，全部需要登录。
 *
 * 钱包本体与三条不变量见 services/tokenWallet.service.js。这一层只做参数校验与限流。
 *
 * ⚠ **充值与购套餐目前是模拟支付**（没有接真实支付网关）。把它们从客户端搬到服务端
 *   **并没有堵上"自己给自己发 token"这个洞** —— 有一个有效登录态就能调。
 *   搬过来的意义是：口径唯一、有流水可审计、有上限可兜底，接支付网关时只改这一处。
 *   在那之前靠 config/tokens.js 的 DAILY_RECHARGE_CAP / DAILY_PLAN_BUYS 挡住脚本刷量。
 *   ★ 这段话是给未来的人看的：别看到"已经在服务端了"就以为可以开门收钱。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const wallet = require("../services/tokenWallet.service");
const { PLANS, planOf, DAILY_RECHARGE_CAP, DAILY_PLAN_BUYS } = require("../config/tokens");

const router = express.Router();

/** 直充包面额白名单（与 app 的 RECHARGE_PACKS 一致）。只收在册面额，
 *  不收任意数字——否则"充 999999999"就是一句话的事 */
const RECHARGE_PACKS = [200_000, 1_000_000, 5_000_000];

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

/** POST /api/me/wallet/recharge —— 直充进 addon（模拟支付，见文件头警告） */
router.post("/recharge", requireAuth, aiRateLimit({ max: 10, scope: "wallet-mint" }), async (req, res, next) => {
  try {
    const tokens = Number(req.body?.tokens);
    if (!RECHARGE_PACKS.includes(tokens)) {
      return res.status(400).json({ ok: false, message: "unknown recharge pack" });
    }
    const { rechargeTokens } = await wallet.mintedToday(req.user._id);
    if (rechargeTokens + tokens > DAILY_RECHARGE_CAP) {
      return res.status(429).json({ ok: false, message: "daily recharge cap reached" });
    }
    const w = await wallet.credit(req.user._id, tokens, "recharge", `直充 ${tokens}`);
    res.json({ ok: true, wallet: w });
  } catch (err) {
    next(err);
  }
});

/** POST /api/me/wallet/plan —— 购/续套餐（模拟支付，见文件头警告） */
router.post("/plan", requireAuth, aiRateLimit({ max: 10, scope: "wallet-mint" }), async (req, res, next) => {
  try {
    const planId = String(req.body?.planId ?? "");
    if (planOf(planId).id !== planId) return res.status(400).json({ ok: false, message: "unknown plan" });
    const { planBuys } = await wallet.mintedToday(req.user._id);
    if (planBuys >= DAILY_PLAN_BUYS) {
      return res.status(429).json({ ok: false, message: "daily plan purchase cap reached" });
    }
    const w = await wallet.buyPlan(req.user._id, planId);
    if (!w) return res.status(404).json({ ok: false, message: "wallet not found" });
    res.json({ ok: true, wallet: w });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
