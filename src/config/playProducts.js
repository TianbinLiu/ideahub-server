// Google Play 商品 → 发多少 token —— **唯一出处**（D15 阶段 1）。
//
// ★ token 数只在这里定义，客户端不抄第二份：GET /api/pay/play/session 把整张表下发，兑换回包里也带着。
// ★ 价格**不在这里**：Play 上的价由 Google 按国家定（客户端显示 BillingClient 给的 formattedPrice），
//   服务端从头到尾不碰金额 —— 所以这类订单的 amountCheck 是 "product"（见 models/TokenOrder.js）。
// ⚠ productId 现在是占位：Play Console 里建商品之前可以改（规格 §0.3 第 6 项）；**建好之后不能改、不能复用**，
//   改这张表之前先去 Console 核一眼。商品形态（只卖消耗型 / 做订阅）以产品决定第 7 条为准，本表只有消耗型。
const PLAY_PRODUCTS = Object.freeze({
  tokens_200k: Object.freeze({ kind: "consumable", tokens: 200_000 }),
  tokens_1m: Object.freeze({ kind: "consumable", tokens: 1_000_000 }),
  tokens_5m: Object.freeze({ kind: "consumable", tokens: 5_000_000 }),
});

/** 在册才回；★ 用 hasOwn 判，别让 "__proto__" / "constructor" 这种键摸到原型上的东西 */
function playProductOf(productId) {
  return Object.prototype.hasOwnProperty.call(PLAY_PRODUCTS, productId) ? PLAY_PRODUCTS[productId] : null;
}

function playProductList() {
  return Object.entries(PLAY_PRODUCTS).map(([productId, p]) => ({ productId, kind: p.kind, tokens: p.tokens }));
}

module.exports = { PLAY_PRODUCTS, playProductOf, playProductList };
