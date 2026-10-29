// src/schemas/branchProject.schemas.js
// 工坊工程（画布快照）请求校验（zod v4）。见 models/BranchProject.js 的文件头。
const { z } = require("../middleware/validate");
// MiniMax H3 成片主机的写法只在 config/minimax 一处（产物代理、转存、这两道门都从那一个片段派生）
const { MINIMAX_V2_VIDEO_HOST_FRAGMENT } = require("../config/minimax");

/**
 * 单份画布的字节上限（`JSON.stringify(canvas)`）。
 *
 * ★★ **这个数是拍的，不是量的**（铁律五：单次测量不算数，何况这一发一次都没量过）。
 *   估算过程：瘦身后每个图位从 1–1.5MB 的 dataURL 换成一条约 100–120 字节的
 *   Cloudinary URL（压缩比约 1.2 万:1）；已 materialize 的发布体在 app 侧被称作
 *   「那个几 KB 的 JSON」，而画布按「3 套方案 + alts + steps」放大 5–20 倍 ——
 *   典型 5 段估 20–80KB，极端 10 段 + 大量 alts 估 200–400KB。2MB 留了 5 倍余量。
 *   ⚠ 上线后按真实分布（BranchProject.bytes 的分位数）调这个数，别照抄。
 */
const PROJECT_MAX_BYTES = 2 * 1024 * 1024;

/** 每人最多留存多少份工程。★ 同样是**拍的**：按"一个活跃作者一年发几十条"估的。 */
const PROJECT_MAX_COUNT = 100;

/** 每人所有工程的字节总和上限。★ 同样是**拍的**：100 条 × 典型 80KB ≈ 8MB，50MB 是天花板不是预期值。 */
const PROJECT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * 「画布里还残留着本机 / 临时地址」的判据。命中即 400，不落库。
 *
 * ★★ `data:` 那一段**必须带 mime 前缀**（`data:[a-z]+/`）：canvas 里有 requirement /
 *   plot / genPrompt / steps 这些**自由文本**字段，裸 `"data:` 会把一句
 *   「data: 这里指的是…」的剧情文案误判成 dataURL，表现是"这条作品永远存不上工程"。
 * ★ 四样都要挡，理由各不相同（见 models/BranchProject.js 的 ★★）：
 *   dataURL → 16MB 单文档上限；`idb:` → 换设备就是死指针；volces/volccdn → 约 24h 过期；
 *   MiniMax H3 的成片（video-product.cdn.minimax.io，2026-10-26 起海外出片走它）→ 官方明说有时效。
 *   ★★ 后两样是**同一类**（上游给的临时成片），只认方舟的话，画布里揣着 H3 链接的工程 / 配方照样落库，
 *   过期之后「回炉重做」拿回来的段是死链，全程零报错（2026-10-26 审核抓到：发布、产物代理、转存都认了 H3，唯独这两道门没跟上）。
 * ★ 前缀那个 `"` 是有意的：只判**整个字段值**是不是资产形状（JSON 里字符串值以引号开头），
 *   不扫自由文本内部。上游那两段没有前导引号，因为它们要匹配的是 host 片段。
 * ★ H3 那一段的主机片段从 config/minimax 取（别在这里再抄一份域名）；后面跟 `(?![\w.-])` 是要主机名到这里**结束** ——
 *   `video-product.cdn.minimax.io.evil.com` 不是它（与 isMinimaxV2VideoUrl 的整名比对同一个口径）。
 * ⚠ v1 真人档的成片（public-cdn-video-data*.aliyuncs.com）**没有**进这道门：那条链接今天在出片后与发布时都没有转存路
 *   （isUpstreamTempVideoUrl 不认它），这里一拦，带真人档段的作品就整份存不上工程 —— 先得有转存，再收紧这道门（2026-10-26 记下的缺口）。
 * ★ 各段都是正则字面量、再用 `.source` 拼（别写成字符串常量：`"\d"` 这类转义在字符串里会悄悄退化）。
 */
const LOCAL_VALUE_RE = /"(?:data:[a-z]+\/|idb:)/;
const ARK_TEMP_RE = /https?:\/\/[^"]*\.(?:volces|volccdn)\.com\//;
const MINIMAX_V2_TEMP_RE = new RegExp(`${/https?:\/\//.source}(?:${MINIMAX_V2_VIDEO_HOST_FRAGMENT.source})${/(?![\w.-])/.source}`);
const NO_LOCAL = new RegExp([LOCAL_VALUE_RE, ARK_TEMP_RE, MINIMAX_V2_TEMP_RE].map((r) => r.source).join("|"), "i");

/** PUT /api/branch/projects/by-video/:videoId */
// ⛔ 不用 `.loose()`：canvas 是 Mixed 落库的，未声明字段能进来就等于给这张表开了个
//   任意写入口（owner / bytes 都是服务端自己算的，客户端报的数一律不信）。
const projectBody = z
  .object({
    title: z.string().trim().max(120).optional().default(""),
    // 这份画布描述的是作品的哪一版。★ 必填：缺了它，回炉打开旧画布再提交会把线上内容
    //   静默退回（见 models/BranchProject.js 的 videoRevision ★★）。
    videoRevision: z.coerce.number().int().min(0).max(100000),
    lostCount: z.coerce.number().int().min(0).max(10000).optional().default(0),
    // 形状（CanvasSnapshot）由客户端定义，服务端不解释内容，只查两条不变量
    canvas: z.unknown(),
  })
  .refine((v) => v.canvas !== undefined && v.canvas !== null, {
    message: "缺少画布正文",
  })
  .refine((v) => !NO_LOCAL.test(JSON.stringify(v.canvas ?? null)), {
    message: "画布里还有本机地址或上游的临时链接（dataURL / idb: / 方舟或 MiniMax 的成片），不能留存",
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v.canvas ?? null)) <= PROJECT_MAX_BYTES, {
    message: "这份工程太大了",
  });

module.exports = {
  projectBody,
  NO_LOCAL,
  PROJECT_MAX_BYTES,
  PROJECT_MAX_COUNT,
  PROJECT_MAX_TOTAL_BYTES,
};
