// AI token 钱包的目录与定价 —— 服务端【权威】的那一份。
//
// ★ 与 app 仓 `src/data/economy.ts` 是同一套数，但**职责不同，不要混淆**：
//     app 侧那份是【报价】——按下按钮之前告诉用户"这一步大概多少"，纯展示；
//     这一份是【结算】——按每一次真实的方舟调用扣费，客户端说什么都不作数。
//   改了任何一个数，两边都要改（跨仓契约，见 app/docs/api-contract.md）。
//   两边不一致的后果是"报价 216k、余额掉了 243k"，用户会觉得被偷了钱。
//
// ★ 为什么不能只信客户端报的价：改客户端就能报 0。整个"把钱包搬到服务端"这件事，
//   要害就在这里——余额判断与扣费必须发生在**服务端拿到请求体之后、转发出去之前**。

/** 订阅套餐。plan 额度每月刷新（作废未用完的），addon 永不过期 */
const PLANS = [
  { id: "free", name: "免费版", price: 0, monthlyTokens: 300_000 },
  { id: "std", name: "标准套餐", price: 30, monthlyTokens: 2_000_000 },
  { id: "pro", name: "专业套餐", price: 98, monthlyTokens: 8_000_000 },
];

const DEFAULT_PLAN_ID = "free";

function planOf(id) {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

// ── 单次调用的 token 等价 ────────────────────────────────────────────────
// 折算基准：标准档视频 15 元/M token。其余按各自单价折成同一把尺子，
// 用户看到的数字就是真实资源消耗，不做虚拟汇率。

/** 一次 Seedream 出图（约 0.2 元/张 ⇒ 0.2/15 M ≈ 13.3k） */
const IMAGE_TOKENS = 13_300;
/** 一次豆包对话往返（含人设与历史的保守值） */
const CHAT_TURN_TOKENS = 400;
/** 一次 Seed3D 建模（约 2.4 元/次 ⇒ 160k）。全站最贵的单次操作 */
const MODEL3D_TOKENS = 160_000;

/** Seedance 档位系数（相对标准档 1-0-pro）。★ 与 app 的 VIDEO_TIERS 一一对应 */
const VIDEO_MULT = {
  "doubao-seedance-1-0-pro-fast-251015": 0.3,
  "doubao-seedance-1-0-pro-250528": 1,
  "doubao-seedance-2-0-mini-260615": 1.6,
};

const MODEL3D_ID = "doubao-seed3d-2-0-260328";

/** 一段 720p 视频的 token（方舟公式：时长×宽×高×帧率/1024，×档位系数） */
function segTokens(durationSec, model) {
  const d = Math.max(3, Math.min(10, Math.round(Number(durationSec) || 5)));
  const base = (d * 1280 * 720 * 24) / 1024;
  return Math.round(base * (VIDEO_MULT[model] ?? 1));
}

/**
 * 这一次方舟调用要扣多少 token。
 *
 * @param {string} kind "image" | "chat" | "task"
 * @param {object} body 已解析的请求体
 * @returns {number} 0 = 不计费（轮询、产物代理）
 *
 * ★ 只按**真实发生的调用**计费，不按"客户端说他要干什么"。
 *   于是 app 那边的打包报价天然等于服务端逐笔之和，例如炼一张卡 =
 *   1 次 chat(400) + 1 次 image(13.3k) = app 的 forgeCost(1)。
 *
 * ★ 已知不完全一致的两处（写在这里免得以后被当成 bug 反复查）：
 *   1. 「生成本段」的 app 报价只含 segTokens，但管线在缺设定帧时还会补画首/尾帧，
 *      服务端会如实各收一次 IMAGE_TOKENS。也就是**实际可能比报价高**。
 *   2. 看图说话（chatVision）app 按帧报 VISION_FRAME_TOKENS×N，服务端按一次 chat 收。
 *      也就是**实际可能比报价低**。
 *   两边都是"如实按调用收"，要对齐得改 app 的报价口径，不是改这里。
 */
function priceOf(kind, body) {
  if (kind === "image") return IMAGE_TOKENS;
  if (kind === "chat") return CHAT_TURN_TOKENS;
  if (kind === "task") {
    const model = String(body?.model ?? "");
    if (model === MODEL3D_ID) return MODEL3D_TOKENS;
    return segTokens(body?.duration, model);
  }
  return 0;
}

// ★ 这里原来有 DAILY_RECHARGE_CAP / DAILY_PLAN_BUYS 两个「模拟支付的防滥用上限」。
//   那时 /api/me/wallet/recharge 调一下就到账，任何有登录态的人都能给自己发 token，
//   这两个数是唯一的兜底。2026-08 发币口搬到了支付回调（services/payment/），
//   下单不再发币，每日上限也就没有意义了——不给币，刷多少次都是 0。
//   现在挡刷单靠的是 routes/pay.routes.js 上的 aiRateLimit（下单本身也不该被刷爆）。
//   `tokenWallet.service.mintedToday` 还留着：它是查"今天发了多少币"的现成工具，
//   对账时用得上，只是没有调用方在拿它做闸门了。

module.exports = {
  PLANS,
  DEFAULT_PLAN_ID,
  planOf,
  IMAGE_TOKENS,
  CHAT_TURN_TOKENS,
  MODEL3D_TOKENS,
  MODEL3D_ID,
  VIDEO_MULT,
  segTokens,
  priceOf,
};
