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

/** 区域 → 上游根地址。★ 只有这一处知道域名，路由不许再写死 */
const BASES = Object.freeze({
  cn: "https://api.minimaxi.com/v1",
  intl: "https://api.minimax.io/v1",
});

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

/** 两把 key 都配了却没说走哪边 —— 生产自检据此报错（config/preflight） */
function minimaxRegionAmbiguous() {
  const want = String(process.env.MINIMAX_REGION || "").trim().toLowerCase();
  if (want === "cn" || want === "intl") return false;
  return Boolean(keyOf("cn")) && Boolean(keyOf("intl"));
}

module.exports = { BASES, KEY_ENV, minimaxRegion, minimaxConfigured, minimaxBase, minimaxKey, minimaxRegionAmbiguous };
