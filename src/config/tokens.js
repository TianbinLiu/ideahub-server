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

// ── 出图（Seedream）：按 model 计价，不是一口价 ─────────────────────────
//
// ★ 2026-08-11 之前这里是一个常量 `IMAGE_TOKENS = 13_300`，而 priceOf **拿到了请求体
//   却不读里面的 model** —— 也就是顶档按最低档收费。铸卡分成三档之后顶档与低档差 3 倍，
//   这个缺口就是每张顶档图白送 0.4 元。而它没有任何症状：用户无感、界面无错、
//   测试全绿，只有火山账单知道。这正是本仓最怕的那种错，所以价目必须挂在 model 上。
//
// 折算口径与视频同一把尺子：**元/张 ÷ 15 元/百万 token**（15 = Seedance 1.0-pro 标准档）。
// ⚠ 单价取自方舟公开价目（2026-08-11 核对），**尚未与控制台账单对过**。
//   真实结算永远以账单为准；发现偏差改这一张表，并同步 app 的 IMAGE_TOKENS_BY_MODEL。

/**
 * 三档铸卡（速写/定妆/精绘）用的出图模型与单价。
 * ★ 与 app 仓 `src/data/economy.ts` 的 `IMAGE_TOKENS_BY_MODEL` **逐条相等**（跨仓契约）。
 *   对照钉在 `tests/arkProxy.spec.js`「跨仓出图价目一致性」，改一边不改另一边就会红。
 */
const IMAGE_TOKENS_BY_MODEL = {
  // 0.20 元/张 ÷ 15 元/M = 13,333。像素区间实测 [921,600, 16,777,216]
  "doubao-seedream-4-0-250828": 13_333,
  // 0.25 元/张 ÷ 15 元/M = 16,667。像素区间实测 [3,686,400, 16,777,216]
  "doubao-seedream-4-5-251128": 16_667,
  // 0.60 元/张 ÷ 15 元/M = 40,000。
  // ★ 为什么按 0.60 不按 0.30：pro 的单价按**输出像素**分档（≤236 万 0.30、>236 万 0.60），
  //   而铸卡画布 CARD_SIZE = 1728×2304 = 3,981,312 像素，落在贵的那一档。
  //   app 的 ImageTier.size 是有意用满画布的（压到 236 万以下会让顶档比中档还小）。
  //   哪天 app 把 size 调小了，这个数要一起改成 20,000 —— 两张表都改。
  "doubao-seedream-5-0-pro-260628": 40_000,
};

/**
 * 老客户端还在发的出图模型。**不能从在册名单里删。**
 *
 * 新版 app 已经把 `arkClient.MODELS.image` 改成跟着默认档走
 * （`imageTierOf(DEFAULT_IMAGE_TIER).model` = 4.0），所以**新包不再发它**；
 * 但**已经装机的 APK 改不了** —— 它们补设定帧、推三套方案的首尾帧、出 AI 封面
 * 全都还在发这个 id。从白名单里删掉的表现不是"降级"，是那批用户**出图整条 400**
 * （而客户端把 400 当敏感词处理，连重试都不会做）。铁律七。
 *
 * ⚠⚠ 2026-08-13 **账单实测**：这个 id 在账单里的名字是 **Doubao-Seedream 5.0 Lite**，
 *   单价 **¥0.22/张**（文生图与图像编辑同价）⇒ 真值应是 0.22/15 = **14,667**。
 *   （此前这里写着"公开价目里查不到"—— 那句话是错的，查不到只是因为它在账单里
 *   叫另一个名字。app 的档位表当初把它排除在外，依据的正是那个错误前提。）
 *
 * ★★ 即便如此，这一格**仍然保持 13,300，不许改成 14,667**：
 *   老包的 `economy.IMAGE_TOKENS` 就是 13,300，它按这个数**给用户报价**。
 *   服务端改成 14,667 就成了"页面报 13,300、实际扣 14,667" —— 正是 CLAUDE.md 里
 *   「页面报 ¥25、实际扣 ¥15」那条事故，只是方向反过来、坑的是用户。
 *   老客户端改不了，所以只能让服务端迁就它。
 * ★ 代价是每张少收 1,367（约 10%），差价我们自己吃。**明知故犯，不是遗漏** ——
 *   多收才是骗人，少收只是我们亏钱；而且这批调用会随老版本淘汰而归零。
 * ★ 这张表的寿命 = 老版本的寿命。确认线上没有旧包在发它之后，连同白名单一起删。
 */
const LEGACY_IMAGE_TOKENS = {
  "doubao-seedream-5-0-260128": 13_300,
};

/**
 * 出图的完整查价表（在册档 + 老客户端那一档）。
 *
 * ★ 用 Map 而不是把两个对象拼成一个普通对象：`model` 是**用户可控的字符串**，
 *   普通对象上 `obj["constructor"]` / `obj["toString"]` 会顺着原型链返回一个**函数**，
 *   而那个"价格"再往下传就是把函数交给 Mongo 的 $inc —— 500，甚至更难看的东西。
 *   Map 只认自己塞进去的 key。（路由上其实够不着：在册检查排在扣费之前；
 *   但 imageTokensOf 是导出的，别的调用方不该依赖那个顺序。）
 */
const IMAGE_PRICES = new Map([
  ...Object.entries(IMAGE_TOKENS_BY_MODEL),
  ...Object.entries(LEGACY_IMAGE_TOKENS),
]);

/**
 * 出图的**在册模型**。★ 「在册」与「有价」是同一件事，所以只有这一处数据 ——
 * `routes/ark.routes.js` 的 ALLOWED_MODELS 直接摊开它，不另写一份字面量（铁律六）。
 * 分成两张表的话有两种漏法，而且都不报错：
 *   在册了没定价 → 落到下面的兜底，按最贵档收（用户被多扣）；
 *   定价了没在册 → 这一档永远 400（用户觉得"这档坏了"）。
 */
const IMAGE_MODELS = new Set(IMAGE_PRICES.keys());

/** 已知最贵的一档出图。认不出的模型按它收，理由见 imageTokensOf */
const MAX_IMAGE_TOKENS = Math.max(...Object.values(IMAGE_TOKENS_BY_MODEL));

/**
 * 一次出图扣多少 token。
 *
 * ★ 认不出的 model **按已知最贵的一档收，并且吼一嗓子**。三个选项各自的后果：
 *   - 按最便宜的收（或沿用老常量）：等于白送，而且**永远不会有人发现** ——
 *     界面正常、日志干净，只有火山账单知道。今天这个缺口就是这么来的。
 *   - 直接 throw / 500：billedForward 会把它变成 500，**整条出图链路当场全挂**。
 *     出图端点是用户可控 model 的转发口，老客户端随时可能发一个我们没登记的 id
 *     （`MODELS.image` 已经换过两次，每换一次就多一批发老 id 的存量装机），
 *     拿全站可用性去赌一次配置疏漏不划算（铁律七）。
 *   - 按最贵的收：方向选对了 —— 少收是隐形的，多收会被用户当天投诉出来。
 * ★ 而且这条兜底在路由上**够不着**：ALLOWED_MODELS 的出图部分就是 IMAGE_MODELS 本身，
 *   没登记的 model 在扣费之前就被 400 挡掉了。它是第二道保险，不是常规路径。
 *   真跑到这里说明有人扩了白名单却没定价，所以要 console.error；
 *   同时流水的 memo 里带着 `image <model>`，对账时能一眼看出是哪个模型被兜了底。
 * ★ 与 app 的同名函数**行为不同是刻意的**：app 那份是【报价】，在开发期就该当场炸
 *   （抛异常）把配置错暴露出来；这一份是【结算】，跑在真实用户的请求上，不能炸。
 */
function imageTokensOf(model) {
  const known = IMAGE_PRICES.get(model);
  if (known) return known;
  console.error(
    `[tokens] 出图模型 ${String(model).slice(0, 64)} 不在价目表里，` +
      `按最贵档 ${MAX_IMAGE_TOKENS} 收费。请补 IMAGE_TOKENS_BY_MODEL（两仓一起改）`,
  );
  return MAX_IMAGE_TOKENS;
}

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
 *   1. 「生成本段」时管线可能额外调 Seedream，服务端如实按 model 各收一次出图费：
 *      **补画缺失的设定帧那部分 app 已经报进去了**（2026-08 加的 economy.segmentCost，
 *      简约模式两张都补、走参考生视频则一张都不补），别再往这边加一遍——会变成双算。
 *      仍然没报的只剩**圈选改帧**（segmentGen 第①步，每条标注一次 refineFrame），
 *      也就是**用了圈选时实际比报价高**。
 *   2. 看图说话（chatVision）app 按帧报 VISION_FRAME_TOKENS×N，服务端按一次 chat 收。
 *      也就是**实际可能比报价低**。
 *   两边都是"如实按调用收"，要对齐得改 app 的报价口径，不是改这里。
 */
function priceOf(kind, body) {
  // ★ 必须读 body.model。写成常量就是"顶档按最低档收费"，而那种错零症状（见上面的表）。
  if (kind === "image") return imageTokensOf(String(body?.model ?? ""));
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

// ★ 这里原来导出过一个 `IMAGE_TOKENS`（"一张图多少钱"）。**故意删掉**：
//   留着它就等于在按 model 的价目表旁边放第二处"一张图的价"，而两者迟早分叉
//   （今天这个缺口正是分叉的产物）。要一张图的价一律走 imageTokensOf(model)。
module.exports = {
  PLANS,
  DEFAULT_PLAN_ID,
  planOf,
  IMAGE_TOKENS_BY_MODEL,
  LEGACY_IMAGE_TOKENS,
  IMAGE_MODELS,
  imageTokensOf,
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
