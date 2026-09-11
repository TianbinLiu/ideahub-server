// Google Play 结算（GPB）—— 服务端阶段 1：会话、兑换、consume 重试、退款回收（D15，统一执行顺序第 2 批）。
//
// ★★ 这个文件盯着几条「漏了不报错、只会白送或多扣 token」的规矩，每条都有用例（tests/playBilling.spec.js）：
//
//   P1 只认 Google 那边的事实。客户端交来的只有 purchaseToken + productId；买没买、谁买的、几件、是不是测试购买，
//      一律出站问 purchases.productsv2 —— BillingClient 在设备上给的结果是外部输入。
//   P2 状态只认 PURCHASED。PENDING 只记待付（不发币、不 consume）；CANCELLED / PURCHASE_STATE_UNSPECIFIED / 没见过的值
//      一律 not_purchased —— **判肯定**：Google 哪天多一个状态，默认是不发币。
//   P3 账号绑定。下单时客户端把 obfuscatedAccountId（= HMAC(user._id, 盐)）交给 Google，购买记录里原样带回：
//      · 存在但对不上 → account_mismatch，不 consume（让 Google 三天后自动退款，钱回到付钱的人手里）；
//      · 缺失（常见于 Play 商店促销码兑换）→ account_unbound，不 consume，记一条待处理（最终处置按产品决定 6）。
//   P4 一个 purchaseToken 只发一次币：purchaseTokenHash 唯一索引 + 抢 settledAt（沿用 order.service 的 O1）。
//   P5 Google 侧已经消费、本库却没有发过币 → 拒（already_consumed）：那是别处兑过的，或者是重放。
//   P6 一笔只收一件一个商品；测试购买只有 PLAY_ALLOW_TEST_PURCHASES 或管理员才发币，并单独记账（iap_test）。
//   P7 固定顺序：抢 settledAt → 发币进 addon → 标 settled → **最后** consume。consume 不可逆，放最后：
//      先 consume 再发币失败 = 用户付了钱、Google 也不会再退，只能人工补；反过来发了币 consume 失败，
//      重试字段交给清扫器补，最坏是 Google 三天后退款、我们靠 voided 清扫回收。
//   P8 退款回收每一笔只做一次（条件更新抢 voidedAt）；用户已经不在了记 user_gone，不抛、不重试。
//
// ★ 服务端只回 code，句子由客户端出（D7 a）。
const crypto = require("crypto");
const TokenOrder = require("../../models/TokenOrder");
const PlayBillingState = require("../../models/PlayBillingState");
const User = require("../../models/User");
const wallet = require("../tokenWallet.service");
const { newOrderNo, grantForOrder, toOrderPayload } = require("./order.service");
const { playBillingConfig } = require("../../config/playBilling");
const { playProductOf, playProductList } = require("../../config/playProducts");
const { playApi, PlayApiError } = require("./playApi");
const { isAdmin } = require("../../utils/roles");

const CHANNEL = "google_play";

/** obfuscatedAccountId：64 位 hex（Play 限 64 字符），不含明文 PII。没配盐回空串 */
function accountIdOf(userId, cfg = playBillingConfig()) {
  if (!cfg.salt) return "";
  return crypto.createHmac("sha256", cfg.salt).update(String(userId)).digest("hex");
}

const tokenHashOf = (purchaseToken) => crypto.createHash("sha256").update(String(purchaseToken)).digest("hex");

/** GET /session 的回包（开关没开时路由根本不存在，所以 enabled 在这里恒为真，照实给出来） */
function sessionOf(user) {
  const cfg = playBillingConfig();
  return { enabled: cfg.enabled, obfuscatedAccountId: accountIdOf(user._id, cfg), products: playProductList() };
}

const fail = (status, code) => ({ status, body: { ok: false, code } });

async function done(status, code, orderId, userId) {
  const o = await TokenOrder.findById(orderId);
  return {
    status,
    body: {
      ok: true,
      code,
      order: o ? { ...toOrderPayload(o), productId: o.storeProductId } : null,
      wallet: await wallet.getWallet(userId),
    },
  };
}

// ── consume 与它的重试 ────────────────────────────────────────────────────────
/** 最多试几次。退避 1m,2m,4m…封顶 6h，十二次加起来约 30 小时，落在 Google「三天不 consume 就退款」之内 */
const CONSUME_MAX_TRIES = 12;
const CONSUME_LEASE_MS = 60_000;
function consumeBackoffMs(tries) {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, tries - 1));
}

/**
 * 对一张已发币、还没 consume 的单试一次 consume。先抢租约（pm2 双实例别两边同时打）；成功就删掉明文 token。
 * 永不抛。
 * @returns {Promise<"done"|"failed"|"skipped">}
 */
async function tryConsume(orderDocId, now = new Date()) {
  let leased;
  try {
    leased = await TokenOrder.findOneAndUpdate(
      {
        _id: orderDocId,
        channel: CHANNEL,
        consumeState: "pending",
        $or: [{ consumeLeaseUntil: null }, { consumeLeaseUntil: { $lt: now } }],
      },
      { $set: { consumeLeaseUntil: new Date(now.getTime() + CONSUME_LEASE_MS) } },
      { returnDocument: "after" },
    ).select("+purchaseToken storeProductId consumeTries");
  } catch (e) {
    console.warn(`[play] consume 抢租约失败 order=${orderDocId}: ${e?.message || e}`);
    return "skipped";
  }
  if (!leased) return "skipped";
  try {
    if (!leased.purchaseToken) throw new Error("这张单上没有留 purchaseToken，consume 不了");
    await playApi().consume(leased.storeProductId, leased.purchaseToken);
    await TokenOrder.updateOne(
      { _id: leased._id },
      { $set: { consumeState: "done", consumeLastError: "" }, $unset: { purchaseToken: 1, consumeNextAt: 1, consumeLeaseUntil: 1 } },
    );
    return "done";
  } catch (e) {
    const tries = (leased.consumeTries || 0) + 1;
    const why = String(e?.message || e).slice(0, 500);
    await TokenOrder.updateOne(
      { _id: leased._id },
      {
        $set: {
          consumeTries: tries,
          consumeLastError: why,
          consumeNextAt: new Date(now.getTime() + consumeBackoffMs(tries)),
          ...(tries >= CONSUME_MAX_TRIES ? { consumeState: "failed" } : {}),
        },
        $unset: { consumeLeaseUntil: 1 },
      },
    ).catch(() => {});
    console.warn(`[play] consume 失败 order=${leased._id} 第 ${tries} 次: ${why.slice(0, 200)}`);
    return "failed";
  }
}

let consumeSweeping = false;

/** 惰性清扫：到了重试时间的 consume 补一轮。搭在 GPB 请求的车上跑，永不抛（照 assetPurge.service） */
async function sweepPlayConsumes(now = new Date()) {
  if (consumeSweeping) return { tried: 0, done: 0 };
  consumeSweeping = true;
  let tried = 0;
  let ok = 0;
  try {
    const rows = await TokenOrder.find({
      channel: CHANNEL,
      consumeState: "pending",
      $or: [{ consumeNextAt: null }, { consumeNextAt: { $lte: now } }],
    })
      .sort({ consumeNextAt: 1 })
      .limit(5)
      .select("_id")
      .lean();
    for (const r of rows) {
      tried += 1;
      if ((await tryConsume(r._id, now)) === "done") ok += 1;
    }
  } catch (e) {
    console.warn("[play] consume 清扫失败:", e?.message || e);
  } finally {
    consumeSweeping = false;
  }
  return { tried, done: ok };
}

// ── 兑换 ──────────────────────────────────────────────────────────────────────
/**
 * 兑换一笔 Play 购买。
 * @param {{_id: any, role?: string}} user 当前登录的用户（requireAuth 从库里重读过）
 * @param {{purchaseToken?: unknown, productId?: unknown}} body
 * @returns {Promise<{status: number, body: object}>}
 */
async function redeem(user, body, now = new Date()) {
  const cfg = playBillingConfig();
  const purchaseToken = typeof body?.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  const productId = typeof body?.productId === "string" ? body.productId.trim() : "";
  if (!purchaseToken || purchaseToken.length > 4096 || !productId) return fail(400, "bad_request");
  const product = playProductOf(productId);
  if (!product) return fail(400, "unknown_product");
  if (!cfg.salt) return fail(503, "not_configured");

  const hash = tokenHashOf(purchaseToken);
  // P4：兑过了。同一个人 → 幂等回 duplicate（客户端重试、两台设备同时补单都走这条）；换了人 → 拒
  const known = await TokenOrder.findOne({ purchaseTokenHash: hash });
  if (known?.settledAt) {
    if (String(known.user) !== String(user._id)) return fail(403, "account_mismatch");
    if (known.consumeState === "pending") await tryConsume(known._id, now);
    return done(200, "duplicate", known._id, user._id);
  }

  // P1：问 Google
  let purchase;
  try {
    purchase = await playApi().getProductPurchaseV2(purchaseToken);
  } catch (e) {
    if (e instanceof PlayApiError && e.notFound) return fail(409, "not_purchased");
    console.warn(`[play] 查购买失败: ${String(e?.message || e).slice(0, 200)}`);
    return fail(502, "store_unavailable");
  }

  const items = Array.isArray(purchase?.productLineItem) ? purchase.productLineItem : [];
  if (items.length === 0) return fail(409, "not_purchased");
  if (items.length > 1) return fail(400, "quantity_unsupported");
  const item = items[0];
  if (item?.productId !== productId) return fail(400, "unknown_product");
  const offer = item?.productOfferDetails || {};
  if (offer.quantity !== undefined && Number(offer.quantity) !== 1) return fail(400, "quantity_unsupported");

  // P2：只认 PURCHASED；PENDING 另走一条
  const state = purchase?.purchaseStateContext?.purchaseState;
  if (state !== "PURCHASED" && state !== "PENDING") return fail(409, "not_purchased");

  // P3：账号。不对的先拒，别让别人的购买在我名下留一张单
  const accountId = typeof purchase?.obfuscatedExternalAccountId === "string" ? purchase.obfuscatedExternalAccountId : "";
  if (accountId && accountId !== accountIdOf(user._id, cfg)) return fail(403, "account_mismatch");

  // P5：Google 侧已经消费，而本库没有发过币
  if (offer.consumptionState === "CONSUMPTION_STATE_CONSUMED") return fail(409, "already_consumed");

  // P6：测试购买
  const test = Boolean(purchase?.testPurchaseContext);
  if (test && !cfg.allowTestPurchases && !isAdmin(user)) return fail(403, "test_purchase_blocked");

  const orderId = typeof purchase?.orderId === "string" ? purchase.orderId : "";
  // 原文只留对账用得上的几项；purchaseToken 不进 raw（明文 token 单独一列，consume 完就删）
  const snapshot = {
    purchaseState: state,
    orderId,
    regionCode: purchase?.regionCode,
    consumptionState: offer.consumptionState,
    acknowledgementState: purchase?.acknowledgementState,
    purchaseCompletionTime: purchase?.purchaseCompletionTime,
    testPurchase: test,
  };

  // 这个购买的那张单：没有就建（同一个 token 只有一张，唯一索引兜底；并发两条同时建时后到的那条读回来）
  let order;
  try {
    order = await TokenOrder.findOneAndUpdate(
      { purchaseTokenHash: hash },
      {
        $setOnInsert: {
          orderNo: newOrderNo(),
          user: user._id,
          kind: "recharge",
          packTokens: product.tokens,
          amountFen: 0,
          currency: "",
          amountCheck: "product",
          storeProductId: productId,
          purchaseTokenHash: hash,
          channel: CHANNEL,
        },
        $set: { ...(orderId ? { channelTxnId: orderId } : {}), testPurchase: test, raw: snapshot, purchaseToken },
      },
      { upsert: true, returnDocument: "after" },
    );
  } catch (e) {
    if (e?.code !== 11000) throw e;
    order = await TokenOrder.findOne({ purchaseTokenHash: hash });
    if (!order) {
      console.warn(`[play] 建单撞了唯一索引但按 token 找不到（orderId=${orderId} 被另一张单占着？）`);
      return fail(409, "not_purchased");
    }
  }
  if (String(order.user) !== String(user._id)) return fail(403, "account_mismatch");

  if (!accountId) {
    await TokenOrder.updateOne(
      { _id: order._id, settledAt: null },
      { $set: { note: "account_unbound：购买记录里没有 obfuscatedExternalAccountId（常见于 Play 商店促销码），待人工处理" } },
    );
    return fail(403, "account_unbound");
  }
  if (state === "PENDING") {
    await TokenOrder.updateOne(
      { _id: order._id, settledAt: null },
      { $set: { status: "created", note: "pending：Google 回报待付款，付清之前不发币" } },
    );
    return done(202, "pending", order._id, user._id);
  }

  // P7 ①：抢 settledAt（O1）。没抢到 = 并发的另一条已经在发了
  const claim = await TokenOrder.updateOne(
    { _id: order._id, settledAt: null },
    { $set: { settledAt: now, status: "paid", paidAt: now, note: "" } },
  );
  if (claim.matchedCount === 0) return done(200, "duplicate", order._id, user._id);

  // ② 发币进 addon —— 读订单里的快照（packTokens 是建单那一刻写进去的）
  // ★ 这一步失败会留下一张 settledAt 已抢、没发币的单（与 order.service.applyCallback 同一个取舍：宁可少发要人工补，
  //   不可能多发）；它不会被 consume（consumeState 还没写），Google 三天后退款，回收时 grantedTokens 为 0 不会倒扣
  const granted = await grantForOrder(await TokenOrder.findById(order._id));
  // ③ 标 settled，consume 进待办
  await TokenOrder.updateOne(
    { _id: order._id },
    { $set: { status: "settled", grantedTokens: granted, consumeState: "pending", consumeTries: 0 } },
  );
  // ④ 最后 consume。失败不影响这次回包：币已经到账，重试交给清扫器
  await tryConsume(order._id, now);
  return done(200, "settled", order._id, user._id);
}

// ── 退款 / 撤销回收 ────────────────────────────────────────────────────────────
const VOIDED_EVERY_MS = 24 * 3600_000;
/** voidedpurchases.list 只查得到 30 天内；留一分钟余量，别卡在边界上被 Google 拒 */
const VOIDED_WINDOW_MS = 30 * 24 * 3600_000 - 60_000;
const VOIDED_LEASE_MS = 10 * 60_000;
const VOIDED_RETRY_MS = 60 * 60_000;

/**
 * 一笔 voided 购买 → 回收一次（P8）。
 * @returns {Promise<"clawed"|"short"|"userGone"|"unsettled"|"already"|"unknown">}
 */
async function reclaimVoided(v, now = new Date()) {
  const or = [];
  if (typeof v?.purchaseToken === "string" && v.purchaseToken) or.push({ purchaseTokenHash: tokenHashOf(v.purchaseToken) });
  if (typeof v?.orderId === "string" && v.orderId) or.push({ channelTxnId: v.orderId });
  if (!or.length) return "unknown";
  const order = await TokenOrder.findOneAndUpdate(
    { channel: CHANNEL, $or: or, voidedAt: null },
    {
      $set: {
        voidedAt: now,
        note: `Google 回报退款 / 撤销（voidedReason=${v.voidedReason ?? "?"}，voidedSource=${v.voidedSource ?? "?"}）`,
      },
    },
    { returnDocument: "after" },
  );
  if (!order) return (await TokenOrder.exists({ channel: CHANNEL, $or: or })) ? "already" : "unknown";
  if (!order.settledAt || !order.grantedTokens) {
    // 没发过币（待付 / 账号没绑上 / 发币那一步失败）：记下退款就够了，没有可收的
    await TokenOrder.updateOne({ _id: order._id }, { $set: { clawbackState: "done", clawbackShortTokens: 0 } });
    return "unsettled";
  }
  const present = order.user ? await User.exists({ _id: order.user }) : null;
  if (!present) {
    await TokenOrder.updateOne({ _id: order._id }, { $set: { clawbackState: "user_gone", clawbackShortTokens: order.grantedTokens } });
    // ★ 管理员要看得见的一行：人已经不在了，这笔 token 无从回收（不抛、不重试）
    console.warn(`[play][admin] voided 订单 ${order.orderNo}（orderId=${order.channelTxnId || "?"}）的用户已不存在，${order.grantedTokens} token 无从回收`);
    return "userGone";
  }
  const r = await wallet.clawback(order.user, order.grantedTokens, `Play 退款回收 · 订单 ${order.orderNo}`, now);
  const shortTokens = r ? r.shortTokens : order.grantedTokens;
  await TokenOrder.updateOne(
    { _id: order._id },
    { $set: { clawbackState: shortTokens > 0 ? "short" : "done", clawbackShortTokens: shortTokens } },
  );
  return shortTokens > 0 ? "short" : "clawed";
}

/**
 * 退款 / 撤销清扫：一天最多真跑一次（租约落库，双实例只有一个抢得到）。永不抛。
 * @param {{force?: boolean}} [opt] force = 不管距离上次多久（测试、管理员手动触发用）
 */
async function sweepVoidedPurchases(now = new Date(), { force = false } = {}) {
  if (!playBillingConfig().enabled) return { ran: false };
  try {
    try {
      await PlayBillingState.updateOne({ _id: "voided" }, { $setOnInsert: { leaseUntil: null, lastRunAt: null } }, { upsert: true });
    } catch (e) {
      if (e?.code !== 11000) throw e; // 另一个实例同时插了，照常往下抢
    }
    const due = force ? {} : { $or: [{ lastRunAt: null }, { lastRunAt: { $lte: new Date(now.getTime() - VOIDED_EVERY_MS) } }] };
    const before = await PlayBillingState.findOneAndUpdate(
      { _id: "voided", $and: [{ $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, due] },
      { $set: { leaseUntil: new Date(now.getTime() + VOIDED_LEASE_MS) } },
      { returnDocument: "before" },
    );
    if (!before) return { ran: false };

    const last = before.lastRunAt ? new Date(before.lastRunAt).getTime() : 0;
    const since = Math.max(now.getTime() - VOIDED_WINDOW_MS, last - VOIDED_EVERY_MS);
    const stats = { seen: 0, clawed: 0, short: 0, userGone: 0, unsettled: 0, already: 0, unknown: 0 };
    try {
      let pageToken;
      do {
        const page = await playApi().listVoided({ startTime: pageToken ? undefined : since, pageToken });
        for (const v of Array.isArray(page?.voidedPurchases) ? page.voidedPurchases : []) {
          stats.seen += 1;
          stats[await reclaimVoided(v, now)] += 1;
        }
        pageToken = page?.tokenPagination?.nextPageToken || undefined;
      } while (pageToken);
    } catch (e) {
      // 这一轮没扫完：租约拖一个小时再放（Google 挂着的时候别每个请求都去捶它），lastRunAt 不动，下一轮从原处重扫
      await PlayBillingState.updateOne(
        { _id: "voided" },
        { $set: { leaseUntil: new Date(now.getTime() + VOIDED_RETRY_MS), lastError: String(e?.message || e).slice(0, 500) } },
      ).catch(() => {});
      console.warn("[play] voided 清扫失败:", e?.message || e);
      return { ran: false, error: String(e?.message || e), ...stats };
    }
    await PlayBillingState.updateOne({ _id: "voided" }, { $set: { lastRunAt: now, leaseUntil: null, lastError: "" } });
    if (stats.seen) console.log(`[play] voided 清扫：${JSON.stringify(stats)}`);
    return { ran: true, ...stats };
  } catch (e) {
    console.warn("[play] voided 清扫失败:", e?.message || e);
    return { ran: false, error: String(e?.message || e) };
  }
}

/** 搭车清扫（consume 重试 + 退款回收）。不等、不抛。测试环境不自动跑：用例直接调，免得后台那一轮抢了断言的时机 */
function sweepInBackground() {
  if (process.env.NODE_ENV === "test") return;
  void sweepPlayConsumes().catch(() => {});
  void sweepVoidedPurchases().catch(() => {});
}

module.exports = {
  CHANNEL,
  CONSUME_MAX_TRIES,
  accountIdOf,
  tokenHashOf,
  sessionOf,
  redeem,
  tryConsume,
  sweepPlayConsumes,
  reclaimVoided,
  sweepVoidedPurchases,
  sweepInBackground,
};
