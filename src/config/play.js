/**
 * @file play.js - Google Play 结算的配置与商品表
 * @category Config
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md + .env.example + app 仓 docs/api-contract.md
 *
 * ★★ **商品 id 是跨系统契约**：下面这张表里的 `sku` 必须与 Play Console
 *   「应用内商品」里创建的商品 id **逐字相同**，也必须与 App 里传给 Play Billing 的
 *   那个 id 相同。三处对不上的表现是：用户在 Play 那边付了钱，我们这边查出来的
 *   productId 不在表里 ⇒ **不发币**。钱收了、东西没给，这是最糟的一种错法。
 *
 * ★ **价格不在这张表里**，因为价格由 Play Console 按国家设定，而 Play 的
 *   `purchases.productsv2` 回包里**没有任何金额字段**（2026-09-23 核过官方字段表）。
 *   ⇒ 我们只能按 sku 发币，不能像微信/支付宝那样「比对实付金额」。
 *   这也是 Play 这条路**不能复用 order.service.applyCallback** 的根本原因：
 *   那里的 `paidFen < order.amountFen` 守卫在 paidFen 恒为 0 时，会把**每一笔真实
 *   Play 购买**都标成 failed。
 *
 * ★ token 数出自方案 §14.7 的美区阶梯（$1 = 447,563 token 的锚）。
 */
const { PLANS } = require("./tokens");

/** 这台服务器配没配 Play（缺任何一项都当没配；读法照 arkConfigured：每次现读 env） */
function playConfigured() {
  return Boolean(
    String(process.env.PLAY_PACKAGE_NAME || "").trim() &&
      String(process.env.PLAY_SA_EMAIL || "").trim() &&
      String(process.env.PLAY_SA_PRIVATE_KEY || "").trim(),
  );
}

function packageName() {
  return String(process.env.PLAY_PACKAGE_NAME || "").trim();
}

/**
 * RTDN（实时开发者通知）推送过来时用什么认这条请求是 Google 发的。
 * ★ 我们用的是 **Pub/Sub push + 共享密钥**（URL 上的 `?key=`）：最简单、可验证。
 *   没配密钥时 RTDN 端点**一律 404**（不是 403）—— 不向外暴露「这里有个端点」。
 */
function rtdnSecret() {
  return String(process.env.PLAY_RTDN_SECRET || "").trim();
}

/**
 * 商品表。★ `sku` 要与 Play Console 逐字相同。
 * `kind: "recharge"` → 直充进 addon（永不过期）；`kind: "plan"` → 套餐（当月额度）。
 *
 * ⚠ 这几个 token 数与美区定价来自方案 §14.7，**上架前要与 Play Console 里
 *   实际设的价格再核一遍**：表里写 4.5M 而 Console 卖 $16.99 卖成了别的数字，
 *   我们这边照样按 4.5M 发 —— 差价没有任何地方会报错。
 */
const PLAY_PRODUCTS = Object.freeze({
  tokens_150k: { kind: "recharge", tokens: 150_000, label: "150k token" },
  tokens_850k: { kind: "recharge", tokens: 850_000, label: "850k token" },
  tokens_4500k: { kind: "recharge", tokens: 4_500_000, label: "4.5M token" },
});

/** sku → 商品；不在表里返回 null（调用方必须据此拒绝发币，不能猜） */
function productOf(sku) {
  return PLAY_PRODUCTS[String(sku || "")] || null;
}

/** 这个 sku 要发多少 token（按 quantity 相乘：Play 允许一次买多份） */
function tokensOf(sku, quantity = 1) {
  const p = productOf(sku);
  if (!p) return 0;
  const q = Math.max(1, Math.floor(Number(quantity) || 1));
  if (p.kind === "plan") return (PLANS.find((x) => x.id === p.planId) || { monthlyTokens: 0 }).monthlyTokens * q;
  return p.tokens * q;
}

/**
 * 许可测试员的单账号上限（方案 §14.10）。测试购买**照常发币**，所以必须有上限：
 * 日 500,000 / 月 5,000,000。超限只拒这一单，不影响真实购买。
 */
const TEST_PURCHASE_LIMITS = Object.freeze({ daily: 500_000, monthly: 5_000_000 });

module.exports = { playConfigured, packageName, rtdnSecret, PLAY_PRODUCTS, productOf, tokensOf, TEST_PURCHASE_LIMITS };
