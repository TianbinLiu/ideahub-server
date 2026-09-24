/**
 * @file play.service.js - Google Play 结算：服务端查验、发币、消耗、退款回收
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md + app 仓 docs/api-contract.md
 *
 * ══ 为什么不能走 order.service 那条渠道回调的路 ═══════════════════════
 * 微信/支付宝那条路是「渠道回调 → 验签 → 比对实付金额 → 发币」。Play 不是：
 *   ① 没有回调，是**客户端拿着 purchaseToken 来兑**，由我们主动去查；
 *   ② `purchases.productsv2` 的回包里**一个金额字段都没有**（2026-09-23 核过官方字段表）
 *      ⇒ `applyCallback` 里那条 `paidFen < order.amountFen` 会把**每一笔真实购买**
 *      标成 failed。所以 Play 有自己的结算路径，只共用 `TokenOrder` 与钱包。
 *
 * ══ 四条硬规则（做错了不报错，只会白送或白收）═══════════════════════
 * 【P1 发币的抢占条件必须带 `revokedAt: null`】退款通知可能**先于**兑换到达
 *    （慢卡后立刻退款、或 RTDN 抢在客户端前面）。不带这个条件就会「先回收再发币」，
 *    净效果是白送一整包。
 * 【P2 消耗（consume）必须在发币之后】consume 蕴含 acknowledge；先 consume 再发币时，
 *    发币那一步崩了就没有任何痕迹能让我们知道该补发。
 * 【P3 许可测试员的购买照常发币，但 3 分钟不 acknowledge 会被 Google 自动退款】
 *    ⇒ 整条「客户端兑 → 服务端查 → 服务端 consume」必须跑在 3 分钟以内，
 *    且测试购买的退款**不产生欠额**（tokenWallet.revokeTokens 的 isTest）。
 * 【P4 purchaseToken 是幂等键】同一个 token 只能兑一次：`TokenOrder.playPurchaseToken`
 *    上有唯一索引，并发兑换时第二条在数据库层撞死，而不是靠先查后写。
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const TokenOrder = require("../../models/TokenOrder");
const User = require("../../models/User");
const wallet = require("../tokenWallet.service");
const { playConfigured, packageName, productOf, tokensOf, TEST_PURCHASE_LIMITS } = require("../../config/play");

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const T_UPSTREAM = 20_000;

/** access token 缓存。Google 给的有效期是 1 小时，提前 5 分钟换新 */
let cachedToken = { value: "", expiresAt: 0 };

/**
 * 用服务账号私钥换 access token。
 * ★ 不引 google-auth-library：这套「JWT grant」只有这十几行，而多一个依赖就多一条
 *   供应链面。私钥只从 env 读，**永远不进日志**（下面任何 console 都不打 body）。
 */
async function accessToken(now = Date.now()) {
  if (cachedToken.value && cachedToken.expiresAt > now + 5 * 60_000) return cachedToken.value;
  const email = String(process.env.PLAY_SA_EMAIL || "").trim();
  // .env 里的私钥是一行带 \n 的字符串，要还原成真正的换行，否则 jwt.sign 直接抛
  const key = String(process.env.PLAY_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  if (!email || !key) throw new Error("play not configured");

  const iat = Math.floor(now / 1000);
  const assertion = jwt.sign(
    { iss: email, scope: SCOPE, aud: OAUTH_URL, iat, exp: iat + 3600 },
    key,
    { algorithm: "RS256" },
  );
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(T_UPSTREAM),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // ★ 只记状态码与 error 字段，**不打 body**：里面可能回显 assertion
    throw new Error(`play oauth ${res.status} ${String(j.error || "")}`);
  }
  cachedToken = { value: j.access_token, expiresAt: now + Number(j.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function callPlay(path, { method = "GET", body = null } = {}) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(T_UPSTREAM),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, ok: res.ok, json };
}

/**
 * 查一笔购买（productsv2）。
 * ★★ 字段位置是 2026-09-23 核过的：`quantity` / `productId` / `consumptionState`
 *   **不在顶层**，而在 `productLineItem[].productOfferDetails` 里。写成顶层读出来是
 *   undefined ⇒ 数量按 1 算、sku 查不到 ⇒ 不发币，而且不报错。
 * ★ `purchaseState` 的判据必须写成 `=== "PURCHASED"`，不能写 `!== "CANCELLED"`：
 *   枚举里还有 PENDING 与 UNSPECIFIED，后者放行就是给未完成的支付发币。
 */
async function getPurchase(purchaseToken) {
  const r = await callPlay(`/applications/${encodeURIComponent(packageName())}/purchases/productsv2/tokens/${encodeURIComponent(purchaseToken)}`);
  if (!r.ok) return { ok: false, status: r.status, error: String(r.json?.error?.message || "") };
  const j = r.json || {};
  const line = Array.isArray(j.productLineItem) ? j.productLineItem[0] : null;
  const offer = (line && line.productOfferDetails) || {};
  return {
    ok: true,
    state: String(j.purchaseStateContext?.purchaseState || ""),
    productId: String(line?.productId || ""),
    quantity: Math.max(1, Number(offer.quantity) || 1),
    consumptionState: String(offer.consumptionState || ""),
    orderId: String(j.orderId || ""),
    accountId: String(j.obfuscatedExternalAccountId || ""),
    regionCode: String(j.regionCode || ""),
    // `testPurchaseContext` 存在即为许可测试员的购买（里面是 fopType: TEST）
    isTest: Boolean(j.testPurchaseContext),
    acknowledgementState: String(j.acknowledgementState || ""),
    raw: j,
  };
}

/** 消耗（对可消耗商品而言它同时完成 acknowledge）。失败不抛：发币已经完成，这里失败要能重试 */
async function consume(productId, purchaseToken) {
  const r = await callPlay(
    `/applications/${encodeURIComponent(packageName())}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:consume`,
    { method: "POST", body: {} },
  );
  if (!r.ok) console.error(`[play] consume 失败 status=${r.status} ${String(r.json?.error?.message || "").slice(0, 120)}`);
  return r.ok;
}

/**
 * 把「用户账号」编进购买里的那个 id。★ 不能直接用 userId：
 * 官方要求 obfuscated（不可反推），而且它会出现在 Play 的日志与回包里。
 * 用 HMAC(userId) 的前 32 位十六进制，服务端按同一把盐反查（`User.playAccountId`）。
 */
function obfuscatedAccountId(userId) {
  const salt = String(process.env.PLAY_ACCOUNT_SALT || process.env.JWT_SECRET || "");
  return crypto.createHmac("sha256", salt).update(String(userId)).digest("hex").slice(0, 32);
}

/** 今天/本月这个账号的测试购买已经发了多少（方案 §14.10 的上限） */
async function testGrantedSince(userId, since) {
  const rows = await TokenOrder.aggregate([
    { $match: { user: userId, isTest: true, grantedAt: { $gte: since } } },
    { $group: { _id: null, sum: { $sum: "$grantedTokens" } } },
  ]);
  return rows.length ? Number(rows[0].sum) : 0;
}

/**
 * 兑换一笔 Play 购买。客户端拿到 purchaseToken 之后调一次；可以重复调（幂等）。
 * @returns {{ok:boolean, code:string, granted?:number, order?:object, message?:string}}
 */
async function redeem({ user, purchaseToken, now = new Date() }) {
  if (!playConfigured()) return { ok: false, code: "PLAY_NOT_CONFIGURED", message: "本服务尚未接入 Google Play 结算" };
  const token = String(purchaseToken || "").trim();
  if (!token || token.length > 512) return { ok: false, code: "VALIDATION_ERROR", message: "purchaseToken 不合法" };

  // 已经兑过 → 直接回既有结果（P4：唯一索引是并发时真正兜住的那道，这里只是快路径）
  const existing = await TokenOrder.findOne({ playPurchaseToken: token });
  if (existing && existing.grantedAt) {
    return { ok: true, code: "duplicate", granted: existing.grantedTokens, order: existing };
  }
  if (existing && existing.revokedAt) {
    // P1：已经被回收的购买永远不再发币，也不再 consume（R-11）
    return { ok: false, code: "REVOKED", message: "这笔购买已被退款" };
  }

  const p = await getPurchase(token);
  if (!p.ok) return { ok: false, code: "PLAY_LOOKUP_FAILED", message: `查验失败（${p.status}）` };
  if (p.state !== "PURCHASED") return { ok: false, code: "NOT_PURCHASED", message: `这笔购买的状态是 ${p.state || "未知"}` };

  const product = productOf(p.productId);
  if (!product) {
    // ★ 钱收了、商品不认识 —— 这是最糟的一种错法，必须**响亮**（铁律八）
    console.error(`[play] 商品不在表里：${p.productId}（Play Console 与 config/play.js 的 sku 必须逐字相同）`);
    return { ok: false, code: "UNKNOWN_PRODUCT", message: "这个商品暂时无法发放，请联系客服" };
  }

  // 账号绑定：购买时 App 会带 obfuscatedExternalAccountId。对不上说明这笔不是这个账号买的。
  // ★ 老版本 App 可能没带（空串）—— 那种只能放行，但要记一条日志，便于事后核对。
  const expect = obfuscatedAccountId(user._id);
  if (p.accountId && p.accountId !== expect) {
    console.warn(`[play] 账号不匹配 user=${user._id} token=${token.slice(0, 12)}…`);
    return { ok: false, code: "ACCOUNT_MISMATCH", message: "这笔购买不属于当前账号" };
  }
  if (!p.accountId) console.warn(`[play] 购买没带 obfuscatedExternalAccountId（老客户端？）user=${user._id}`);

  const amount = tokensOf(p.productId, p.quantity);

  // 测试购买照常发币，但有日/月上限（§14.10）
  if (p.isTest) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [d, m] = await Promise.all([testGrantedSince(user._id, dayStart), testGrantedSince(user._id, monthStart)]);
    if (d + amount > TEST_PURCHASE_LIMITS.daily || m + amount > TEST_PURCHASE_LIMITS.monthly) {
      console.warn(`[play] 测试购买超限 user=${user._id} 日=${d} 月=${m}`);
      return { ok: false, code: "TEST_LIMIT", message: "测试购买已达上限（单账号 50 万/日、500 万/月）" };
    }
  }

  // 落单。P4：playPurchaseToken 唯一索引在并发时兜住第二条
  let order;
  try {
    order = await TokenOrder.create({
      orderNo: `PLAY${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      user: user._id,
      kind: "recharge",
      packTokens: amount,
      amountFen: 0, // ★ Play 的回包里没有金额（见 config/play.js 的 ★），对账去 Play Console
      currency: "USD",
      channel: "play",
      channelTxnId: p.orderId,
      playPurchaseToken: token,
      playOrderId: p.orderId,
      quantity: p.quantity,
      isTest: p.isTest,
      status: "paid",
      settledAt: now,
      raw: p.raw,
    });
  } catch (e) {
    if (e && e.code === 11000) {
      const again = await TokenOrder.findOne({ playPurchaseToken: token });
      return { ok: true, code: "duplicate", granted: again?.grantedTokens || 0, order: again };
    }
    throw e;
  }

  // ★★ P1：发币的抢占条件带上 `revokedAt: null` —— 退款通知先到时不许再发。
  const claim = await TokenOrder.updateOne({ _id: order._id, grantedAt: null, revokedAt: null }, { $set: { grantedAt: now } });
  if (claim.matchedCount === 0) {
    const fresh = await TokenOrder.findById(order._id);
    return { ok: false, code: "REVOKED", message: "这笔购买已被退款", order: fresh };
  }

  await wallet.credit(user._id, amount, "recharge", `Play ${p.productId}${p.isTest ? "（测试购买）" : ""}`, now);
  await TokenOrder.updateOne({ _id: order._id }, { $set: { status: "settled", grantedTokens: amount } });
  // 记下这个账号的 Play 身份，退款通知只带 token 时靠它找人
  await User.updateOne({ _id: user._id, playAccountId: { $ne: expect } }, { $set: { playAccountId: expect } });

  // P2：发完币再 consume。失败不影响本次结果（清扫器会重试）——
  // ⚠ 但对**测试购买**要当回事：3 分钟不 acknowledge 就会被 Google 自动退款。
  const consumed = await consume(p.productId, token);
  if (consumed) await TokenOrder.updateOne({ _id: order._id }, { $set: { consumedAt: new Date() } });

  return { ok: true, code: "settled", granted: amount, order: await TokenOrder.findById(order._id) };
}

/**
 * 回收一笔被退款/拒付的购买。RTDN 与每小时轮询都会调到，**必须幂等**。
 * @returns {{ok:boolean, code:string, clawed?:number, shortfall?:number}}
 */
async function revokeByToken({ purchaseToken, voidedQuantity = 0, refundType = "", now = new Date() }) {
  const token = String(purchaseToken || "").trim();
  if (!token) return { ok: false, code: "VALIDATION_ERROR" };
  const order = await TokenOrder.findOne({ playPurchaseToken: token });
  if (!order) {
    // 还没兑换过就被退款了：先占位，兑换那一步会看到 revokedAt 而拒绝发币（P1）
    await TokenOrder.updateOne(
      { playPurchaseToken: token },
      {
        $setOnInsert: {
          orderNo: `PLAYVOID${Date.now().toString(36).toUpperCase()}`,
          user: null,
          kind: "recharge",
          amountFen: 0,
          channel: "play",
          playPurchaseToken: token,
          status: "refunded",
          revokedAt: now,
          refundType: String(refundType || ""),
        },
      },
      { upsert: true },
    ).catch((e) => console.error("[play] 退款占位失败:", (e && e.message) || e));
    return { ok: true, code: "voided_before_redeem" };
  }

  // ★ R-5：抢到了 settledAt 却还没 grantedAt，且时间很短 ⇒ 发币可能正在进行中。
  //   这时回收会把欠额算成 0（grantedTokens 还是默认值），清扫器随后照发一整包。
  //   推迟，等下一轮（判据阈值与补发判据同源：5 分钟）。
  const GRANT_GRACE_MS = 5 * 60_000;
  if (order.settledAt && !order.grantedAt && now - new Date(order.settledAt) < GRANT_GRACE_MS) {
    return { ok: false, code: "deferred" };
  }

  // R-3：条件原子抢 revokedAt，只有抢到的那一次真的回收
  const claim = await TokenOrder.updateOne({ _id: order._id, revokedAt: null }, { $set: { revokedAt: now, refundType: String(refundType || "") } });
  if (claim.matchedCount === 0) return { ok: true, code: "duplicate" };

  const granted = Number(order.grantedTokens) || 0;
  // R-6：部分退款按比例。**分母取订单快照里的 quantity** —— 部分退款之后
  // Play 那边的 refundableQuantity 已经变了，回头查 API 会算错。
  const qty = Math.max(1, Number(order.quantity) || 1);
  const voided = Math.max(0, Math.min(qty, Number(voidedQuantity) || 0));
  const clawback = voided > 0 ? Math.floor((granted * voided) / qty) : granted;

  if (!order.user || clawback <= 0) {
    await TokenOrder.updateOne({ _id: order._id }, { $set: { status: "refunded", clawbackTokens: 0, shortfall: 0 } });
    return { ok: true, code: "nothing_to_claw" };
  }

  const r = await wallet.revokeTokens({
    userId: order.user,
    amount: clawback,
    memo: `Play 退款 订单 ${order.orderNo}`,
    isTest: Boolean(order.isTest),
    now,
  });
  await TokenOrder.updateOne(
    { _id: order._id },
    {
      $set: {
        status: "refunded",
        clawbackTokens: clawback,
        shortfall: r ? r.shortfall : 0,
        voidedQuantity: voided,
      },
    },
  );
  await User.updateOne({ _id: order.user }, { $inc: { playRefundCount: 1 } });
  return { ok: true, code: "revoked", clawed: r ? r.clawed : 0, shortfall: r ? r.shortfall : 0 };
}

/**
 * 拉「已作废购买」清单（每小时一轮，只在 0 号实例）。
 * ⚠ **只有在 Play Console 里勾了「撤销」的退款才会出现在这个 API 里**（官方原文）。
 *   手动退款忘了勾撤销 = 钱退了、token 还在用户手上、我们账上完全看不见。
 *   RTDN 也兜不住那个口子（权益没变、大概率不发通知）——那条只能靠人工规程 + Console 对账。
 */
async function pollVoided({ sinceMs = Date.now() - 24 * 3600_000 } = {}) {
  if (!playConfigured()) return { ok: false, code: "PLAY_NOT_CONFIGURED", handled: 0 };
  const r = await callPlay(
    `/applications/${encodeURIComponent(packageName())}/purchases/voidedpurchases?startTime=${Math.floor(sinceMs)}&type=1`,
  );
  if (!r.ok) {
    console.error(`[play] voidedpurchases ${r.status} ${String(r.json?.error?.message || "").slice(0, 160)}`);
    return { ok: false, code: "PLAY_LOOKUP_FAILED", handled: 0 };
  }
  const rows = Array.isArray(r.json?.voidedPurchases) ? r.json.voidedPurchases : [];
  let handled = 0;
  for (const v of rows) {
    const res = await revokeByToken({
      purchaseToken: v.purchaseToken,
      voidedQuantity: Number(v.voidedQuantity) || 0,
      refundType: `${v.voidedSource ?? ""}/${v.voidedReason ?? ""}`,
    }).catch((e) => {
      console.error("[play] 回收失败:", (e && e.message) || e);
      return null;
    });
    if (res && res.code === "revoked") handled += 1;
  }
  return { ok: true, code: "polled", handled, total: rows.length };
}

module.exports = { accessToken, getPurchase, consume, redeem, revokeByToken, pollVoided, obfuscatedAccountId };
