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

// ── 模拟支付的防滥用上限 ────────────────────────────────────────────────
// ⚠ 充值与购套餐目前是**模拟支付**（没有接真实支付网关）。也就是说，只要有一个有效
//   登录态，就能免费给自己发 token。把它们搬到服务端**并没有堵上这个洞**，
//   堵上它需要真实支付回调。搬过来的意义是：口径唯一、可审计、可限量，
//   接支付网关时只要改这一处。
//   在那之前，用下面两个上限做兜底，让脚本刷不出天量额度。
/** 单账号每日直充上限（最大充值包是 5M，给两次的余量） */
const DAILY_RECHARGE_CAP = 10_000_000;
/** 单账号每日购套餐次数上限 */
const DAILY_PLAN_BUYS = 5;

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
  DAILY_RECHARGE_CAP,
  DAILY_PLAN_BUYS,
};
