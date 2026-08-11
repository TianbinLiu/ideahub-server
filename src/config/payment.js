// 支付相关配置与自检。
//
// ★ 现状：**没有接任何真实支付渠道**，也没有配商户凭证。
//   充值链路已经改成「下单 → 渠道回调 → 结算发币」的正经形状，
//   但中间那一环是空的 —— 没有 adapter，回调进不来，订单永远停在 created。
//   这是**故意**的：宁可"充不了值"，也不要留一个谁调谁得 token 的口子。
//
// ★ PAY_ALLOW_MOCK：把演示用假渠道打开。它**没有验签**（没有密钥可验），
//   任何人拿到一个 orderNo 就能把订单标成已支付。所以：
//     · 默认关闭；
//     · 打开时每次启动都会打一条醒目的警告；
//     · NODE_ENV=production 下打开会**直接拒绝启动**（见 collectPaymentProblems）。
//   开发和演示环境需要走通流程，才有它。

/** 演示假渠道开关。只认字符串 "1" / "true"，别的一律当关 */
const PAY_ALLOW_MOCK = /^(1|true)$/i.test(String(process.env.PAY_ALLOW_MOCK || ""));

/** 订单多久没付就自动关闭（分钟）。关掉的订单不再接受回调结算 */
const ORDER_TTL_MIN = Math.max(5, Number(process.env.PAY_ORDER_TTL_MIN) || 30);

/**
 * 支付配置问题。并进 preflight 的总检查里。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function collectPaymentProblems(env = process.env) {
  const problems = [];
  const mockOn = /^(1|true)$/i.test(String(env.PAY_ALLOW_MOCK || ""));
  if (mockOn && env.NODE_ENV === "production") {
    problems.push(
      "PAY_ALLOW_MOCK 在生产环境被打开（假支付渠道没有验签，等于任何人都能给自己发 token）"
    );
  }
  return problems;
}

/** 启动时喊一嗓子：假支付开着这件事不该只写在 .env 里没人看见 */
function warnPaymentMode() {
  if (PAY_ALLOW_MOCK) {
    console.warn(
      "⚠️  PAY_ALLOW_MOCK=1：演示用假支付渠道已启用，充值**不经过任何验签**。生产环境切勿开启。"
    );
  }
}

module.exports = { PAY_ALLOW_MOCK, ORDER_TTL_MIN, collectPaymentProblems, warnPaymentMode };
