// src/schemas/minimaxV2.schemas.js
// MiniMax H3（V2 出片，POST /api/minimax/v2/video，2026-10-26）请求体的白名单。
//
// 分工（一条规则一处实现，铁律六）：
//   · **字段名单与价钱**在 config/tokens（MINIMAX_V2_BODY_KEYS / ITEM_KEYS / IMAGE_KEYS、minimaxV2Tokens）——
//     这里的形状**照那几份名单建**，模块一加载就核对一遍（对不上直接抛：启动就红，不留到某一发请求才发现）；
//   · **每个字段取什么值**在这里：model 只收价目表里那三个、resolution 要对得上 model、时长是窗口内的整数、
//     content 只收一条文字 + 至多 5 张图、role 怎么配、首尾帧与参考图互斥、图片只收我们自己图床上的 https、ratio 怎么给。
//   路由先过这里、再拿**这里重建出来的那一份**请求体去问 minimaxV2Tokens（报不出价 = 两处对不上，整句拒），之后扣费、转发的都是这一份。
//
// ★ 名单外的键一律**拒**（strictObject），不像 v1 真人档那样悄悄丢掉：价目那边已经定了「带着没估过价的东西就答不出值多少」，
//   上游这个端点还收 callback_url（拿我们的 key 替别人往任意地址 POST）、extra、video_url / audio_url（输入视频按时长另收）。
//   拒而不丢的另一个理由：V2 是新端点，只有带 H3 三档的新 App 会打它 —— 多带一个字段只会是 App 的 bug，响比悄悄吞了好。
// ★ 拒绝话（parseV2CreateBody 回的 message）只用 JSON 里不用转义的字符：客户端给的键名过 safeName，不原样拼进句子。
const { z } = require("../middleware/validate");
const { cloudinary } = require("../config/cloudinary");
const {
  MINIMAX_SEC_COST,
  MINIMAX_V2_MAX_IMAGES,
  MINIMAX_V2_BODY_KEYS,
  MINIMAX_V2_ITEM_KEYS,
  MINIMAX_V2_IMAGE_KEYS,
  videoSecWindow,
} = require("../config/tokens");

/**
 * 一段提示词最多几个字（按字符数，不按 UTF-16 码元 —— 官方说 text「按字符计」）。
 * ★ 官方上限是 7000；2000 是**我们的**产品口径（2026-10-26 付费小验：Seedance 与 H3 都收 2000 字的提示词，
 *   电影级上 936 字的五段时间轴逐段照做）。放到 7000 是放宽，要有人点头、App 那一侧一起改。
 */
const V2_TEXT_MAX = 2000;

/**
 * 提示词按字符数（码点）超没超 V2_TEXT_MAX。
 * ★ 先看 UTF-16 长度（O(1)）：一个字符最多占两格，超过 2 × 上限的一定超；之后才逐字数、数到上限 + 1 就停。
 *   别写成 `[...text].length`：那要先把整串摊成一个数组 —— 2026-10-26 终审在这份白名单上量过：4000 万字的提示词
 *   让事件循环卡住约 1.6 秒、多占约 1GB 内存，之后才回一句「最多 2000 个字」；而这一步排在扣费与并发闸之前，
 *   任何登录用户都能不花钱地连着发。数法与字符串迭代器相同（成对的代理项算一个字，落单的算一个）。
 */
function textTooLong(text) {
  if (text.length > V2_TEXT_MAX * 2) return true;
  if (text.length <= V2_TEXT_MAX) return false;
  let n = 0;
  for (let i = 0; i < text.length; n += 1) {
    if (n === V2_TEXT_MAX) return true;
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
  }
  return false;
}

/** 一个图片地址最长多少（Cloudinary 的地址带变换也就一两百字；再长的只会是拼进去的东西） */
const V2_URL_MAX = 2048;

/** 图片条目的 role：首帧 / 尾帧 / 参考图（官方还有 reference_video / reference_audio，我们不收 —— 没估过价、MINIMAX_V2_ITEM_KEYS 里也没有那两种条目） */
const V2_IMAGE_ROLES = Object.freeze(["first_frame", "last_frame", "reference_image"]);
const FRAME_ROLES = new Set(["first_frame", "last_frame"]);

/** 具体画幅（官方 V2 的 ratio 枚举去掉 adaptive） */
const V2_CONCRETE_RATIOS = Object.freeze(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const V2_RATIOS = Object.freeze(["adaptive", ...V2_CONCRETE_RATIOS]);

// ── 形状（照 config/tokens 的名单建，见 assertSameKeys）────────────────────
const imageObject = z.strictObject({ url: z.string().min(1).max(V2_URL_MAX) });
// text 的 .max 按 UTF-16 长度、只是让拒绝话干净（超长的那一条在形状这一关就有记录）；按字数的上限与「别把整串摊开」在下面的 textTooLong。
// ⚠ 它拦不住下面的 superRefine 照跑（zod 4 里字符串的 .max 不中断），所以那边自己也先看长度
const textItem = z.strictObject({ type: z.literal("text"), text: z.string().max(V2_TEXT_MAX * 2) });
const imageItem = z.strictObject({ type: z.literal("image_url"), image_url: imageObject, role: z.enum(V2_IMAGE_ROLES) });
const bodyShape = {
  model: z.enum(Object.keys(MINIMAX_SEC_COST)),
  resolution: z.string(),
  duration: z.number().int(),
  ratio: z.enum(V2_RATIOS).optional(),
  content: z
    .array(z.discriminatedUnion("type", [textItem, imageItem]))
    .min(1)
    .max(1 + MINIMAX_V2_MAX_IMAGES),
};

/**
 * 形状的键与 config/tokens 的名单逐个相等 —— 不等就在 require 这一拍抛（启动即红）。
 * ★ 为什么要核：两份对不上的后果都是零症状 —— 这里多放一个键，minimaxV2Tokens 在最后那一道才拒（拒的话是一句「报不了价」，
 *   人看不懂）；这里少放一个键，价目那边认的字段永远发不出去。核在加载时，测试与启动都会撞上。
 */
function assertSameKeys(what, actual, expected) {
  const a = [...actual].sort().join(",");
  const e = [...expected].sort().join(",");
  if (a !== e) throw new Error(`[minimaxV2.schemas] ${what} 的字段（${a}）与 config/tokens 的名单（${e}）对不上`);
}
assertSameKeys("请求体", Object.keys(bodyShape), MINIMAX_V2_BODY_KEYS);
assertSameKeys("text 条目", Object.keys(textItem.shape), MINIMAX_V2_ITEM_KEYS.text);
assertSameKeys("image_url 条目", Object.keys(imageItem.shape), MINIMAX_V2_ITEM_KEYS.image_url);
assertSameKeys("image_url 对象", Object.keys(imageObject.shape), MINIMAX_V2_IMAGE_KEYS);

/** 这一段是哪种出片：首尾帧（i2v）/ 参考图（r2v）/ 纯文字（t2v）—— 画幅的规矩按它分 */
function v2ModeOf(content) {
  const roles = content.filter((it) => it.type === "image_url").map((it) => it.role);
  if (roles.some((r) => FRAME_ROLES.has(r))) return "frames";
  if (roles.length) return "refs";
  return "text";
}

/**
 * 参考图 / 首尾帧的地址只收**我们自己图床上的图**：`https://res.cloudinary.com/<我们的 cloud>/image/upload/…`。
 * ★ 为什么收这么窄（与 ark.routes 产物代理的 ASSET_HOST_RE 同一个取向：白名单写到能写的最窄）：
 *   · 上游拿我们的 key 去拉这个地址 —— 收任意地址，就是任何人都能让 MiniMax 替他去拉任意网址、账记在我们名下；
 *   · 只认主机（res.cloudinary.com）也不够：那是 Cloudinary 所有客户共用的域，别人的 cloud 里放什么我们管不着；
 *   · App 的帧 / 临时参考图 / 卡片形象图都经 POST /api/uploads/image 传到这里（content-images 等目录），出片前本来就要转成 https。
 *   data: 内联图、mm_file://、方舟的临时链接一律不收：官方建议用地址别用 base64（整个请求体 ≤ 64MB），方舟链接 24 小时就过期。
 * ★ 2026-10-26 付费小验：H3 直接收我们 Cloudinary 的 https 地址（5 发都成）。
 * @returns {string|null} null = 收；否则是拒绝的原因（整句的前半）
 */
function ownImageUrlIssue(raw) {
  const cloud = String(cloudinary.config().cloud_name || "");
  if (!cloud) {
    // 配置问题要响：这时候所有带图的 H3 出片都会被拒
    console.error("[minimax-v2] Cloudinary 没配 cloud_name：认不出哪些是我们图床上的图，带图的 H3 出片一律拒");
    return "这台服务器没配图床，收不了参考图";
  }
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return "图片地址不是合法的网址";
  }
  const ours =
    u.protocol === "https:" &&
    u.hostname === "res.cloudinary.com" &&
    !u.port &&
    !u.username &&
    !u.password &&
    u.pathname.startsWith(`/${cloud}/image/upload/`);
  return ours ? null : "图片要先传到我们的图床再发（只收 https 的图床地址；data: 内联图、别的网址都不收）";
}

/** 客户端给的键名 / 值进拒绝话之前：只留标识符那几种字符、截短（不让引号、反斜杠、换行进句子） */
function safeName(s) {
  return String(s ?? "").replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 32) || "?";
}

/** zod 的 path → 人看得懂的位置 */
function whereOf(path = []) {
  if (!path.length) return "请求体";
  const [head, idx, ...rest] = path;
  if (head === "content" && typeof idx === "number") {
    return `content 第 ${idx + 1} 条${rest.length ? `的 ${rest.map(safeName).join(".")}` : ""}`;
  }
  return path.map((p) => (typeof p === "number" ? `第 ${p + 1} 条` : safeName(p))).join("的 ");
}

/** 一个 zod 问题 → 一句话（自己写的 custom 原样用；zod 自带的英文换成中文） */
function issueText(issue) {
  if (!issue) return "请求体不合规";
  if (issue.code === "custom") return issue.message;
  const path = issue.path || [];
  const where = whereOf(path);
  const last = path[path.length - 1];
  if (!path.length && issue.code === "invalid_type") return "请求体要是一个 JSON 对象";
  switch (issue.code) {
    case "unrecognized_keys":
      return `${where}里不认 ${(issue.keys || []).map(safeName).join("、")} 这个字段`;
    case "invalid_union":
      // 判别字段 type 认不出：位置说到「第几条」就够了（zod 的 path 末尾带着 type）
      return `${whereOf(last === "type" ? path.slice(0, -1) : path)}的类型不认（只收 text 与 image_url 两种）`;
    case "invalid_value":
      if (last === "model") return `model 只收 ${Object.keys(MINIMAX_SEC_COST).join(" / ")}`;
      if (last === "role") return `图片的 role 只收 ${V2_IMAGE_ROLES.join(" / ")}`;
      if (last === "ratio") return `ratio 只收 ${V2_RATIOS.join(" / ")}`;
      return `${where} 的值不认`;
    case "too_big":
      if (last === "content") return `content 最多 ${1 + MINIMAX_V2_MAX_IMAGES} 条（一条文字 + 最多 ${MINIMAX_V2_MAX_IMAGES} 张图）`;
      return `${where} 太长了`;
    case "too_small":
      if (last === "content") return "content 至少要有一条文字";
      return `${where} 不能是空的`;
    case "invalid_type":
      // 5.5、"5" 都落在这里：上游只收整数枚举，这里不替它取整（minimaxV2Tokens 的同一条）
      if (last === "duration") return "duration 只收整数秒（不收小数，也不收写成字符串的数）";
      return issue.input === undefined ? `缺少 ${where}` : `${where} 的类型不对`;
    default:
      return `${where} 不合规`;
  }
}

/** 跨字段的规矩（形状过了才跑） */
const createBody = z.strictObject(bodyShape).superRefine((b, ctx) => {
  const bad = (path, message) => ctx.addIssue({ code: "custom", path, message });
  // ★ zod 4 在「多了一个键」这类不中断的问题上照样跑这里 —— 别的字段可能根本没解析成功。先确认要用的几样在，
  //   不在就交给形状那边已经记下的问题（这里抛出去就是 500，不是 400）
  if (!b || !Object.hasOwn(MINIMAX_SEC_COST, b.model) || !Array.isArray(b.content) || typeof b.duration !== "number") return;
  if (!b.content.every((it) => it && (it.type === "text" ? typeof it.text === "string" : typeof it?.image_url?.url === "string"))) return;

  // resolution 要对得上 model（价目表里那一格；大写，上游原样的写法）
  const resolutions = Object.keys(MINIMAX_SEC_COST[b.model]);
  if (!resolutions.includes(b.resolution)) {
    bad(["resolution"], `${b.model} 只出 ${resolutions.join(" / ")}（resolution 写的是 ${safeName(b.resolution)}）`);
  }
  // 时长：窗口内的整数（窗口只在 tokens.videoSecWindow 一处；整数由 shape 管）
  const [lo, hi] = videoSecWindow(b.model);
  if (b.duration < lo || b.duration > hi) bad(["duration"], `时长只能是 ${lo}~${hi} 秒的整数`);

  // 文字：恰好一条、按字符数不超过 V2_TEXT_MAX、去掉首尾空白之后不是空的（官方：每个请求必须有一条非空的 text）。
  // ★ 长度排在 trim 之前：trim 也要把整串走一遍、可能再复制一份（textTooLong 的 ★）
  const texts = b.content.filter((it) => it.type === "text");
  if (texts.length !== 1) bad(["content"], texts.length ? "content 里只能有一条文字" : "content 里要有一条文字（提示词）");
  else if (textTooLong(texts[0].text)) bad(["content"], `提示词最多 ${V2_TEXT_MAX} 个字`);
  else if (!texts[0].text.trim()) bad(["content"], "提示词不能是空的");

  // 图：首帧 / 尾帧各至多一张；参考图至多 MINIMAX_V2_MAX_IMAGES 张；首尾帧与参考图不能混（官方：两种场景互斥）
  const images = b.content.map((it, i) => ({ it, i })).filter(({ it }) => it.type === "image_url");
  const count = (role) => images.filter(({ it }) => it.role === role).length;
  if (count("first_frame") > 1) bad(["content"], "首帧只能有一张");
  if (count("last_frame") > 1) bad(["content"], "尾帧只能有一张");
  if (count("reference_image") > MINIMAX_V2_MAX_IMAGES) bad(["content"], `参考图最多 ${MINIMAX_V2_MAX_IMAGES} 张`);
  if (count("reference_image") && (count("first_frame") || count("last_frame"))) {
    bad(["content"], "首尾帧与参考图不能放在同一段里（二选一）");
  }
  for (const { it, i } of images) {
    const why = ownImageUrlIssue(it.image_url.url);
    if (why) bad(["content", i, "image_url", "url"], `content 第 ${i + 1} 条：${why}`);
  }

  // 画幅：
  //   · 首尾帧（i2v）：上游一律按图的比例出（官方：给别的值不报错、但当成 adaptive）—— 只收 adaptive 或不写，免得 App 以为写了 9:16 就是 9:16；
  //   · 参考图（r2v）与纯文字（t2v）：**必须写具体比例**。t2v 是官方硬规矩（不许 adaptive）；r2v 上 H3-Lite 不收 adaptive（官方原文），
  //     另外两个虽然收，我们一样要具体比例 —— 一条规矩比「看是哪个模型」好记，App 那一段的画幅本来就是知道的。
  const mode = v2ModeOf(b.content);
  if (mode === "frames") {
    if (b.ratio !== undefined && b.ratio !== "adaptive") bad(["ratio"], "带首帧 / 尾帧时画幅跟着图走，ratio 只能是 adaptive（或不写）");
  } else if (b.ratio === undefined || b.ratio === "adaptive") {
    bad(["ratio"], `${mode === "refs" ? "参考图出片" : "纯文字出片"}要写明画幅（${V2_CONCRETE_RATIOS.join(" / ")}）`);
  }
});

/**
 * 校验并**重建** V2 出片请求体。
 * @param {unknown} raw req.body
 * @returns {{ ok: true, body: object } | { ok: false, message: string }}
 *   body 是按白名单重建的新对象（键序固定、首尾帧时补上 ratio: "adaptive"）—— 路由拿它问价、扣费、转发，不再碰 req.body。
 *   message 是拒绝的原因（整句的前半，路由再接「没有受理、没有扣费」）。
 */
function parseV2CreateBody(raw) {
  const r = createBody.safeParse(raw);
  if (!r.success) {
    const issues = r.error?.issues || [];
    // 先说「多了哪个字段」（最根本：名单外的东西一个都不放），再说自己写的跨字段那几条（比 zod 自带的「类型不对」更能说清怎么改）
    const first = issues.find((i) => i.code === "unrecognized_keys") || issues.find((i) => i.code === "custom") || issues[0];
    return { ok: false, message: issueText(first) };
  }
  const b = r.data;
  const content = b.content.map((it) =>
    it.type === "text" ? { type: "text", text: it.text } : { type: "image_url", image_url: { url: it.image_url.url }, role: it.role },
  );
  const ratio = v2ModeOf(content) === "frames" ? "adaptive" : b.ratio;
  return { ok: true, body: { model: b.model, resolution: b.resolution, duration: b.duration, ratio, content } };
}

module.exports = {
  V2_TEXT_MAX,
  V2_IMAGE_ROLES,
  V2_CONCRETE_RATIOS,
  V2_RATIOS,
  createBody,
  parseV2CreateBody,
  ownImageUrlIssue,
  v2ModeOf,
};
