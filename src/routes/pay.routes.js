/**
 * 支付端点。挂在 /api/pay。
 *
 * ★ 现在**一个真实渠道都没接**。下单能下、订单能查，但没有任何渠道会来回调，
 *   订单会一直停在 created 直到超时关闭。这是骨架，不是能收钱的东西。
 *   接渠道要做的事只有两件：写一个 adapter、在 services/payment/channels.js 注册。
 *   本文件不需要改。
 *
 * ★ 回调端点**不能要求登录**（渠道服务器不带用户 token），所以它的安全**完全**
 *   压在 adapter.verify 的验签上。没有 adapter = 没有验签 = 一律 400，
 *   绝不能"未知渠道当成功处理"。
 */
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit, rateLimit } = require("../middleware/rateLimit");
const TokenOrder = require("../models/TokenOrder");
const orders = require("../services/payment/order.service");
const { channelOf, availableChannels } = require("../services/payment/channels");
const { PAY_ALLOW_MOCK } = require("../config/payment");
const { PLANS } = require("../config/tokens");
const play = require("../services/payment/play.service");
const { playConfigured, PLAY_PRODUCTS, rtdnSecret } = require("../config/play");

const router = express.Router();

/** GET /api/pay/config —— 客户端据此决定显示哪些支付方式、卖什么价 */
router.get("/config", (req, res) => {
  const channels = availableChannels();
  res.json({
    ok: true,
    channels,
    // ★ 一个渠道都没有时把话说明白，别让客户端对着空数组自己猜
    payable: channels.length > 0,
    mock: PAY_ALLOW_MOCK,
    packs: orders.RECHARGE_PACKS,
    plans: PLANS,
    // Google Play 结算。★ Play 版的包里**只能**用这一条：Play 政策要求应用内数字商品
    //   走 Play Billing，微信/支付宝只在侧载与网页版里用（两者不是"可选其一"）。
    play: {
      enabled: playConfigured(),
      // sku 必须与 Play Console 里创建的商品 id 逐字相同（见 config/play.js 的 ★★）
      products: Object.entries(PLAY_PRODUCTS).map(([sku, p]) => ({ sku, kind: p.kind, tokens: p.tokens ?? 0, label: p.label })),
    },
  });
});

/**
 * POST /api/pay/play/redeem —— 客户端拿到 purchaseToken 之后来兑。
 *
 * ★ **幂等**：同一个 token 重复兑只发一次币（唯一索引兜底），所以客户端可以放心重试 ——
 *   而且**必须**重试：许可测试员的购买 3 分钟内没被 acknowledge 会被 Google 自动退款，
 *   而 consume 就发生在这条链路的末尾。
 * ★ 限流按账号 30 次/分钟：真实购买远到不了这个频率，重试也够用。
 */
router.post("/play/redeem", requireAuth, aiRateLimit({ max: 30, scope: "play-redeem" }), async (req, res, next) => {
  try {
    if (!playConfigured()) return res.status(501).json({ ok: false, code: "PLAY_NOT_CONFIGURED", message: "本服务尚未接入 Google Play 结算" });
    const r = await play.redeem({ user: req.user, purchaseToken: String(req.body?.purchaseToken ?? "") });
    if (!r.ok) {
      // ★ 状态码分得开：客户端要据此决定"再试一次"还是"别试了"
      const status = r.code === "VALIDATION_ERROR" ? 400 : r.code === "REVOKED" || r.code === "ACCOUNT_MISMATCH" ? 409 : r.code === "TEST_LIMIT" ? 429 : 502;
      return res.status(status).json({ ok: false, code: r.code, message: r.message });
    }
    res.json({ ok: true, code: r.code, granted: r.granted, wallet: await require("../services/tokenWallet.service").getWallet(req.user._id) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/pay/play/account —— 把这个账号的**混淆 id** 交给客户端。
 *
 * ★★ 没有这条，账号绑定那道闸就是空的（2026-09-25 评审）：`obfuscatedAccountId` 是
 *   HMAC(服务端密钥, userId)，客户端算不出来；拿不到就只能不带，而服务端对「没带」
 *   只打一行 warn 就放行 —— 于是「别人的购买兑不到我账上」这句话没有任何东西在兑现。
 * ★ App 在发起 Play 购买时把它设进 `obfuscatedAccountId`（Billing 的
 *   `setObfuscatedAccountId`），购买回包里就会带着它回来。
 */
router.get("/play/account", requireAuth, (req, res) => {
  if (!playConfigured()) return res.status(501).json({ ok: false, code: "PLAY_NOT_CONFIGURED" });
  res.json({ ok: true, obfuscatedAccountId: play.obfuscatedAccountId(req.user._id) });
});

/**
 * POST /api/pay/play/rtdn?key=… —— Google Pub/Sub 的推送订阅打到这里（实时开发者通知）。
 *
 * ★★ **不能要求登录**（Google 不带我们的 token），所以安全压在 URL 上的共享密钥上，
 *   而且密钥没配时**一律 404** —— 不向外暴露"这里有个端点"。
 * ★ 必须**很快回 2xx**：Pub/Sub 认 ack，回慢了会重推。真正的回收在里面做完再回也行
 *   （单条通知的处理很轻），但任何错误都要回 200 + 记日志，否则 Google 会无限重推同一条。
 * ★ 通知体是 base64 的 `message.data`，解出来是 `{ version, packageName, eventTimeMillis,
 *   oneTimeProductNotification | voidedPurchaseNotification | … }`。
 */
router.post("/play/rtdn", rateLimit({ windowMs: 60_000, max: 120, scope: "play-rtdn" }), async (req, res) => {
  const secret = rtdnSecret();
  if (!secret || String(req.query.key || "") !== secret) return res.status(404).json({ ok: false });
  try {
    const raw = String(req.body?.message?.data || "");
    const payload = raw ? JSON.parse(Buffer.from(raw, "base64").toString("utf8")) : {};
    const voided = payload.voidedPurchaseNotification;
    if (voided && voided.purchaseToken) {
      // ★★ 部分退款（refundType=2）**不在这里收**（2026-09-25 评审）：
      //   Google 的 voidedPurchaseNotification **本来就不带份数**，在这里收就只能按全额收 ——
      //   买 3 份退 1 份会被收走全部，差额转欠额 + 冻结；而一小时后带着正确份数的轮询
      //   撞上 `revokedAt` 的幂等抢占，在算 clawback 之前就 return duplicate，**永不纠正**。
      //   所以这一类只当「去看一眼」的信号，交给 pollVoided（它带 includeQuantityBasedPartialRefund）。
      const partial = String(voided.refundType ?? "") === "2";
      if (partial) {
        console.warn(`[play] RTDN 部分退款，交给轮询按份数处理 token=${String(voided.purchaseToken).slice(0, 12)}…`);
      } else {
        const r = await play.revokeByToken({
          purchaseToken: String(voided.purchaseToken),
          // productType 1=一次性商品；refundType 1=全额 2=部分（官方枚举，含义见文档）
          refundType: `rtdn/${String(voided.refundType ?? "")}`,
        });
        console.warn(`[play] RTDN 退款 token=${String(voided.purchaseToken).slice(0, 12)}… → ${r.code}`);
      }
    }
  } catch (e) {
    // ★ 解析失败也回 200：回非 2xx 只会让 Pub/Sub 无限重推同一条坏消息（铁律八：响而局部）
    console.error("[play] RTDN 处理失败:", (e && e.message) || e);
  }
  res.json({ ok: true });
});

/**
 * POST /api/pay/orders —— 下单
 * body: { kind: "recharge", tokens } | { kind: "plan", planId }
 * 返回 { order, payParams }。payParams 由渠道给（骨架期为 null）。
 */
router.post("/orders", requireAuth, aiRateLimit({ max: 20, scope: "pay-order" }), async (req, res, next) => {
  try {
    const kind = String(req.body?.kind ?? "");
    const r =
      kind === "recharge"
        ? await orders.createRechargeOrder(req.user._id, req.body?.tokens)
        : kind === "plan"
          ? await orders.createPlanOrder(req.user._id, String(req.body?.planId ?? ""))
          : { error: "unknown order kind" };
    if (r.error) return res.status(400).json({ ok: false, message: r.error });

    // 渠道可选：客户端可以先下单、再选支付方式。没指定或渠道没接就只回订单
    const channel = channelOf(req.body?.channel);
    let payParams = null;
    if (channel) {
      payParams = await channel.createPayment(r.order);
      await TokenOrder.updateOne({ _id: r.order._id }, { $set: { channel: channel.name } });
      r.order.channel = channel.name;
    }

    res.status(201).json({
      ok: true,
      order: orders.toOrderPayload(r.order),
      payParams,
      // 没有可用渠道时明确告诉客户端"这单付不了"，别让用户对着转圈的收银台等
      payable: availableChannels().length > 0,
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/pay/orders/:orderNo —— 查单（仅本人）。客户端付款后轮询这个等结算 */
router.get("/orders/:orderNo", requireAuth, async (req, res, next) => {
  try {
    const o = await TokenOrder.findOne({ orderNo: String(req.params.orderNo), user: req.user._id });
    if (!o) return res.status(404).json({ ok: false, message: "order not found" });
    res.json({ ok: true, order: orders.toOrderPayload(o) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/pay/orders —— 我的订单列表（对账/客服用） */
router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const items = await TokenOrder.find({ user: req.user._id }).sort({ createdAt: -1, _id: -1 }).limit(limit);
    res.json({ ok: true, items: items.map(orders.toOrderPayload) });
  } catch (err) {
    next(err);
  }
});

/** POST /api/pay/orders/:orderNo/close —— 用户主动取消（仅未支付的） */
router.post("/orders/:orderNo/close", requireAuth, async (req, res, next) => {
  try {
    const o = await orders.closeOrder(String(req.params.orderNo), req.user._id, "用户取消");
    if (!o) return res.status(409).json({ ok: false, message: "order not closable" });
    res.json({ ok: true, order: orders.toOrderPayload(o) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/pay/callback/:channel —— 渠道异步通知。
 *
 * ★ 无鉴权（渠道服务器不带 token），安全全靠 adapter.verify 验签。
 * ★ 限流按 IP 且给得很松：渠道重试是正常行为，把正经回调限掉会导致订单卡在 paid
 *   永远不发币 —— 用户付了钱没到账，比被刷几下严重得多。
 * ★ 无论结算成功与否都要按渠道的格式应答；应答错了渠道会一直重推。
 */
router.post(
  "/callback/:channel",
  rateLimit({ windowMs: 60 * 1000, max: 300, scope: "pay-callback" }),
  async (req, res, next) => {
    const name = String(req.params.channel || "");
    const channel = channelOf(name);
    // O3：没接的渠道一律拒绝。没有 adapter 就没有验签，放行等于白送 token
    if (!channel) {
      console.warn(`[pay] 收到未注册渠道的回调：${name}`);
      return res.status(400).json({ ok: false, message: "unknown payment channel" });
    }
    try {
      const v = await channel.verify(req);
      if (!v || !v.ok) {
        console.warn(`[pay] ${name} 回调验签未通过`);
        return channel.ack(res.status(400), false);
      }
      const r = await orders.applyCallback(name, v);
      // duplicate 也算成功：渠道重推是正常现象，回失败它会一直推下去
      console.log(`[pay] ${name} 回调 order=${v.orderNo} → ${r.code}`);
      return channel.ack(r.ok ? res : res.status(400), r.ok);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/pay/mock/pay —— 演示用：把自己的订单标成已支付。
 * 只有 PAY_ALLOW_MOCK 打开时才存在。★ 它要求登录且只能付**自己的**订单，
 * 比真回调多一道限制——假渠道没有验签，至少不能让人随便付别人的单。
 */
if (PAY_ALLOW_MOCK) {
  router.post("/mock/pay", requireAuth, aiRateLimit({ max: 20, scope: "pay-mock" }), async (req, res, next) => {
    try {
      const orderNo = String(req.body?.orderNo ?? "");
      const o = await TokenOrder.findOne({ orderNo, user: req.user._id });
      if (!o) return res.status(404).json({ ok: false, message: "order not found" });
      const r = await orders.applyCallback("mock", {
        ok: true,
        orderNo,
        channelTxnId: `mock_${orderNo}`,
        paidFen: o.amountFen,
        raw: { mock: true },
      });
      res.status(r.ok ? 200 : 400).json({ ok: r.ok, code: r.code, order: orders.toOrderPayload(r.order) });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = router;
