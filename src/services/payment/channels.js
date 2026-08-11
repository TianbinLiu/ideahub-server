// 支付渠道适配器注册表。
//
// ★ 现在**一个真实渠道都没接**。这个文件的意义是把"接渠道"这件事收敛成
//   「写一个 adapter + 在下面注册」，而不是散落在路由里改 if-else。
//
// adapter 接口（三个方法，缺一不可）：
//
//   name          渠道标识，出现在回调 URL /api/pay/callback/:channel 里
//
//   createPayment(order) -> Promise<object>
//                 向渠道下单，返回给客户端拉起支付用的参数（微信的 prepay_id、
//                 支付宝的 orderStr 之类）。骨架期返回 {} 即可。
//
//   verify(req)   -> Promise<{ ok, orderNo, channelTxnId, paidFen, failed?, raw }>
//                 ★★ 这是整条链路上**唯一**的安全关口。它必须：
//                   1. 用商户密钥验签，签名不过一律 ok:false；
//                   2. 从**回调体本身**取 orderNo / 流水号 / 实付金额，
//                      不能信任 query 或 header 里的同名参数（那些没进签名）；
//                   3. 只回报事实，不做任何发币动作 —— 发币在 settleOrder 里，
//                      那里才有幂等保护。
//                 没有 adapter 就没有验签，所以未注册的渠道**必须拒绝**，
//                 绝不能"未知渠道当成功处理"（那等于任何人 POST 一下就能白拿 token）。
//
//   ack(res, ok)  按渠道要求回一个它认的应答体。回错了渠道会一直重推。
//
// ⚠ 商户密钥只从环境变量读，永远不写进仓库、日志或回调原文的打印里。
const { PAY_ALLOW_MOCK } = require("../../config/payment");

/**
 * 演示用假渠道。**默认不注册**，只有显式打开 PAY_ALLOW_MOCK 才有。
 *
 * ★ 它没有验签 —— 因为压根没有密钥可验。也就是说打开这个开关的环境里，
 *   任何人只要知道一个 orderNo 就能把它标成已支付。生产环境开这个 = 白送 token，
 *   所以 config/payment.js 的自检在 NODE_ENV=production 下会直接拒绝启动。
 */
const mockChannel = {
  name: "mock",
  async createPayment(order) {
    // 假渠道没有真正的收银台，把订单号回给客户端，由它自己调 /api/pay/mock/pay 完成
    return { mock: true, orderNo: order.orderNo };
  },
  async verify(req) {
    const b = req.body || {};
    return {
      ok: true,
      orderNo: String(b.orderNo || ""),
      channelTxnId: String(b.channelTxnId || `mock_${b.orderNo || ""}`),
      paidFen: Number(b.paidFen || 0),
      failed: b.failed === true,
      raw: b,
    };
  },
  ack(res, ok) {
    res.json({ ok });
  },
};

/** name -> adapter。真实渠道接进来时在这里 push */
const registry = new Map();
if (PAY_ALLOW_MOCK) registry.set(mockChannel.name, mockChannel);

/** 拿一个渠道适配器；未注册返回 null（调用方必须据此拒绝，不能放行） */
function channelOf(name) {
  return registry.get(String(name || "")) ?? null;
}

/** 当前可用的渠道名（客户端据此决定给用户显示哪些支付按钮） */
function availableChannels() {
  return [...registry.keys()];
}

module.exports = { channelOf, availableChannels, mockChannel };
