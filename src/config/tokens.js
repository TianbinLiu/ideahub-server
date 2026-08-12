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

/**
 * Seedance 2.5 的模型 id。单独提出来是因为它同时出现在三个地方
 * （档位系数、仅付费白名单、ark.routes 的 ALLOWED_MODELS），
 * 写字面量的话改版本戳时必然漏一处，而漏掉的那处不会报错——
 * 只会表现成"这一档突然按 1 倍收费"或"付费门禁形同虚设"。
 */
const SEEDANCE_2_5 = "doubao-seedance-2-5-260628";

/** Seedance 档位系数（相对标准档 1-0-pro）。★ 与 app 的 VIDEO_TIERS 一一对应 */
const VIDEO_MULT = {
  "doubao-seedance-1-0-pro-fast-251015": 0.3,
  "doubao-seedance-1-0-pro-250528": 1,
  "doubao-seedance-2-0-mini-260615": 1.6,
  // ★ 4.7 = 70 ÷ 15（口径：该模型的 元/百万 token ÷ 标准档 1.0-pro 的 15 元/M）。
  //   ⚠ 这个 70 **不是从方舟官方价目表页面读到的**（那一页抓不到内容），是两个独立
  //   来源互相印证的结果：① 一处直接给出 "Seedance 2.5 = 70 元/百万 token"（不含视频
  //   输入；带参考视频输入是 42）；② 另一处给出 "720P 每秒约 1.51 元"，而 1 秒
  //   720p24 = 1280×720×24/1024 = 21600 token = 0.0216M ⇒ 1.51/0.0216 ≈ 69.9 元/M。
  //   两者吻合，所以取 70。**最终请以控制台实际账单为准**——发现偏差时改这一处，
  //   并同步 app/src/data/economy.ts 里同名档位的 mult（跨仓契约，见下面的一致性测试）。
  [SEEDANCE_2_5]: 4.7,
};

/**
 * 仅付费套餐可调用的模型。★ **"这一档对不对某个套餐开放"的判据只有 `paidOnlyDenial` 一处**，
 * 这个集合只是它的数据。
 *
 * 为什么 2.5 要挡住免费版：按上面的系数，**即使取最短的 3 秒**，
 * 一段 = 3×1280×720×24/1024 × 4.7 ≈ 304,560 token，已经超过免费版**整月**的
 * 300,000 额度。也就是说免费用户点下去必定 402——与其让他花几十秒填完需求、
 * 推演完方案、在最后一步被"余额不足"打回来（钱还真扣过 Seedream 的图），
 * 不如在提交的那一刻就把原因说清楚。
 *
 * ★ 客户端也会把这一档置灰，但那只是**提示**，不是安全边界：改一行前端就能绕过去，
 *   而绕过去的代价是我们替他付 70 元/M 的账单。真正的门在这里。
 */
const PAID_ONLY_MODELS = new Set([SEEDANCE_2_5]);

/** 这个套餐是不是免费档。判据是**月费为 0**，不是 `id === "free"`——
 *  以后加一个 0 元的体验档，按 id 判会把它当付费用户放进来。 */
function isFreePlan(planId) {
  return planOf(planId).price <= 0;
}

/**
 * 免费套餐调用「仅付费」模型时的拒绝理由。
 *
 * @returns {string|null} null = 放行；字符串 = 直接显示给用户的原因
 *
 * ★ 返回的是**能直接显示的整句话**，不是错误码：全 app 没有任何地方监听
 *   `emitApiError`，服务端只回一个 `PLAN_REQUIRED` 的话，客户端要么显示成天书、
 *   要么自己再拼一遍文案（第二处实现，两边措辞一分叉就没人知道以哪份为准）。
 * ★ 与 402「余额不足」是**两件事**，不能合并：402 充值就能解决，这一条充多少钱
 *   都没用（要换套餐）。把它们做成同一个错误，用户会一直充值一直被拒。
 */
function paidOnlyDenial(planId, model) {
  if (!PAID_ONLY_MODELS.has(String(model || ""))) return null;
  if (!isFreePlan(planId)) return null;
  return `这一档（${model}）仅对付费套餐开放：单段消耗超过免费版整月额度，升级套餐后即可使用。`;
}

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
 *   1. 「生成本段」时管线可能额外调 Seedream，服务端如实各收一次 IMAGE_TOKENS：
 *      **补画缺失的设定帧那部分 app 已经报进去了**（2026-08 加的 economy.segmentCost，
 *      简约模式两张都补、走参考生视频则一张都不补），别再往这边加一遍——会变成双算。
 *      仍然没报的只剩**圈选改帧**（segmentGen 第①步，每条标注一次 refineFrame），
 *      也就是**用了圈选时实际比报价高**。
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
  SEEDANCE_2_5,
  VIDEO_MULT,
  PAID_ONLY_MODELS,
  isFreePlan,
  paidOnlyDenial,
  segTokens,
  priceOf,
};
