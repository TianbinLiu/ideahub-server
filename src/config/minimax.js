/**
 * @file minimax.js - MiniMax（海螺）的区域分流：往哪个站打、用哪把 key
 * @category Config
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md + .env.example
 *
 * ★★ 中国站与国际站是**两套账号、两把 key、两个域名**，互不相通：
 *      cn   https://api.minimaxi.com/v1   ← MINIMAX_API_KEY（2026-08 起在用的那把）
 *      intl https://api.minimax.io/v1     ← MINIMAX_INTL_API_KEY
 *   把国际站的 key 配到中国站的地址上，只会得到一路鉴权失败 —— 而那时用户已经
 *   点了「生成」，扣费与退款各走一遍，症状是「真人档一直失败」，没人看得出是配错了站。
 *   路径形状两边**逐字相同**（`/video_generation`、`/query/video_generation`、
 *   `/files/retrieve`，2026-09-26 核过官方 API 文档），所以差别只有 base 与 key 两样。
 *
 * ★★ **任务是绑区域的**：在哪个站创建的任务，只能在**同一个站、用同一把 key**查询与取件。
 *   所以换区域这件事对在途任务是破坏性的 —— 切换之后那批任务查不到、取不到，
 *   而钱已经扣了。真要切，等在途任务跑完（最长一次出片的时间）再切。
 *
 * ★ 读法照 `arkGateway.arkConfigured`：每次现读 env，不在模块顶层缓存 ——
 *   测试与热改配置都靠这一点。
 */

/** 区域 → 上游主机（不带版本号）。★ 只有这一处知道域名，路由与清扫器不许再写死 */
const HOSTS = Object.freeze({
  cn: "https://api.minimaxi.com",
  intl: "https://api.minimax.io",
});

/** 区域 → v1 接口的根地址（真人档：`/video_generation`、`/query/video_generation`、`/files/retrieve`） */
const BASES = Object.freeze({
  cn: `${HOSTS.cn}/v1`,
  intl: `${HOSTS.intl}/v1`,
});

/**
 * 区域 → V2 接口的根地址（MiniMax H3：`/video_generation`、`/query/video_generation/{task_id}`，2026-10-26）。
 * ★ 不能拿 BASES 拼：BASES 自带 /v1，拼出来是 `/v1/v2/...`（2026-10-26 设计审核抓到）。官方 V2 文档的 servers 是
 *   不带版本号的 `https://api.minimax.io`、路径是 `/v2/video_generation` —— 2026-10-26 付费小验就是这么打通的。
 * ★ 只有国际站一格：V2 只在国际站开（minimaxV2Enabled 的 ★）。中国站那套账号的 V2 没有核过，不给它一个地址，
 *   免得哪天有人顺手把 minimaxV2Enabled 放宽、请求就打到一个没核过的站上。
 */
const V2_BASES = Object.freeze({
  intl: `${HOSTS.intl}/v2`,
});

/**
 * MiniMax H3（V2）成片的落点主机：查询回包 `task.content.url` 的域（2026-10-26 付费小验：5 发全落在这里，
 * 形如 `https://video-product.cdn.minimax.io/<档>/<日期>/…_aigc.mp4`，官方 V2 查询文档的示例也是它）。
 * 产物代理（/api/ark/asset）与转存（videoAsset.isUpstreamTempVideoUrl）都认它（判据都是下面的 isMinimaxV2VideoUrl） —— **只认这一个主机**，不放开 minimax.io 整个域
 * （与真人档那条 `public-cdn-video-data*` 前缀同一个取向：放开整个域就是把别人的东西也变成我们代理的跳板）。
 * ★ 链接**有时效**（官方：「Video output URLs are time-limited」）：成片一出就要转存，发布时也要再兜一次；
 *   回炉工程与公开配方那两道门（schemas/branchProject 的 NO_LOCAL）也认它 —— 画布里揣着它就不许落库。
 * ★ 主机的写法**只有这一处**：下面这个不带锚点、不带标志的片段是正本，两个用处都从它派生（铁律六：
 *   两处各写一份域名，哪天 MiniMax 换了 CDN 只改了一处，另一处就悄悄放过）——
 *   · MINIMAX_V2_VIDEO_HOST_RE：整个主机名恰好是它（判一个已经拆好的 hostname）；
 *   · NO_LOCAL：在一整段 JSON 文本里找它（扫画布 / 配方），见 schemas/branchProject。
 */
const MINIMAX_V2_VIDEO_HOST_FRAGMENT = /video-product\.cdn\.minimax\.io/;
const MINIMAX_V2_VIDEO_HOST_RE = new RegExp(`^(?:${MINIMAX_V2_VIDEO_HOST_FRAGMENT.source})$`, "i");

/** 这个地址是不是 MiniMax H3 的成片（https + 上面那个主机；别的协议 / 端口 / 带账号密码的写法一律不算） */
function isMinimaxV2VideoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && !u.port && !u.username && !u.password && MINIMAX_V2_VIDEO_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

/** 区域 → 对应的环境变量名 */
const KEY_ENV = Object.freeze({ cn: "MINIMAX_API_KEY", intl: "MINIMAX_INTL_API_KEY" });

function keyOf(region) {
  return String(process.env[KEY_ENV[region]] || "").trim();
}

/**
 * 这台服务器走哪个区域。
 *
 * 判据（顺序固定）：
 *   ① `MINIMAX_REGION` 显式指定且那一侧**确实有 key** → 听它的；
 *   ② 否则谁有 key 就走谁；
 *   ③ 两把都有而没写 `MINIMAX_REGION` → **走国际站**，并且生产自检会把这件事报出来
 *      （见 config/preflight）。这里仍然给一个确定的答案，不留「行为取决于读取顺序」的暗门。
 * @returns {"cn"|"intl"|null} null = 一把 key 都没配
 */
function minimaxRegion() {
  const want = String(process.env.MINIMAX_REGION || "").trim().toLowerCase();
  if ((want === "cn" || want === "intl") && keyOf(want)) return want;
  if (keyOf("intl")) return "intl";
  if (keyOf("cn")) return "cn";
  return null;
}

/** 这台服务器配没配 MiniMax（健康端点与「要不要白跑一趟」都只问这一处） */
function minimaxConfigured() {
  return minimaxRegion() !== null;
}

/** 当前区域的上游根地址；没配 key 时 null */
function minimaxBase() {
  const r = minimaxRegion();
  return r ? BASES[r] : null;
}

/**
 * 当前区域的 key；没配时空串。
 * ★ 绝不打印、绝不进响应体（铁律三）。调用方只把它放进 Authorization 头。
 */
function minimaxKey() {
  const r = minimaxRegion();
  return r ? keyOf(r) : "";
}

/**
 * 这台服务器开不开 MiniMax H3（V2 出片：`kind: "minimax_v2"`，价目在 config/tokens.MINIMAX_SEC_COST）。
 * **判据只有这一处**（2026-10-26）：V2 出片路由开不开（不开就在扣费之前回 501）、/api/ark/health 报不报这个能力、
 * 地区门禁的拒绝话（config/videoRegion.swapVariant：海外的免费用户换到 MiniMax 有没有免费的那一档）都问它 ——
 * 三处各判一遍，就会出现「拒绝话说换过去免费、路由其实没开」。
 * ★ 只在国际站开：
 *   ① 2026-10-26 定的：中国用户选 MiniMax 也走国际站（与真人档同一条路），H3 我们只接国际站；
 *   ② 价目是按国际站的美元刊例折的（MINIMAX_SEC_COST 的 ★），中国站那套账号的价钱与字段没有核过；
 *   ③ 任务绑站（见文件头 ★★）：一台服务器只走一个站，走中国站的那台就没有 V2。
 */
function minimaxV2Enabled() {
  return minimaxRegion() === "intl";
}

/**
 * V2 出片此刻往哪个根地址打；V2 没开（没配 key / 走中国站）时 null —— 路由见 null 就在扣费之前 501。
 * 开不开只问 minimaxV2Enabled（上面那一处），这里只把站名换成地址。
 */
function minimaxV2Base() {
  return minimaxV2Enabled() ? minimaxV2BaseOf(minimaxRegion()) : null;
}

/**
 * 某个站的 V2 根地址（清扫器按账上记的站回去问：任务绑站，见文件头 ★★）。没有 V2 的站回 null。
 * ★ 查表用 Object.hasOwn：region 来自库里的一行，`constructor` 之类别顺原型链拿到东西。
 */
function minimaxV2BaseOf(region) {
  const r = String(region ?? "");
  return Object.hasOwn(V2_BASES, r) ? V2_BASES[r] : null;
}

/** 两把 key 都配了却没说走哪边 —— 生产自检据此报错（config/preflight） */
function minimaxRegionAmbiguous() {
  const want = String(process.env.MINIMAX_REGION || "").trim().toLowerCase();
  if (want === "cn" || want === "intl") return false;
  return Boolean(keyOf("cn")) && Boolean(keyOf("intl"));
}

module.exports = {
  HOSTS,
  BASES,
  V2_BASES,
  KEY_ENV,
  MINIMAX_V2_VIDEO_HOST_FRAGMENT,
  MINIMAX_V2_VIDEO_HOST_RE,
  isMinimaxV2VideoUrl,
  minimaxRegion,
  minimaxConfigured,
  minimaxBase,
  minimaxKey,
  minimaxV2Enabled,
  minimaxV2Base,
  minimaxV2BaseOf,
  minimaxRegionAmbiguous,
};
