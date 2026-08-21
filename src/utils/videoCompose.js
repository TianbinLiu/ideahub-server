// src/utils/videoCompose.js
// 「把 N 段成片拼成一条」这条规则的**唯一实现**（铁律六）：归属判据 + 变换串拼装 + 期望时长。
//
// 为什么服务端要有这个：App 的剪辑页原本用 MediaRecorder + canvas.captureStream 在端上
// 实时重录合并 —— 耗时恒等于片长、低端机掉帧直接烙进成片、切后台就 rAF 节流卡死，
// 而弱网真机上它连素材都拉不完（2026-08-21 实测：合并失败，成片最后是本机 ffmpeg 救回的）。
// 段落早就都在 Cloudinary 上了（出片即转存），拼接这件事让 CDN 自己做就行。
//
// ══ 这里的每一行形状都是 2026-08-21 在真账号上量出来的，不是照文档抄的 ══
// 三个**静默陷阱**（返回 200、无错误头、产物却是另一个东西），全部由本文件的拼装形状堵死：
//
//  ① `fl_splice` 必须与 `l_video:` 写在**同一个组件**里。
//     写成 `l_video:X/fl_splice,fl_layer_apply` 的话：HTTP 200、无 x-cld-error，
//     产物是**画中画叠加**（时长 = 基片时长，被叠的那段的声音还会混进来）——
//     出片成功、钱照花、商品被静默换掉。实测：正确写法 10.083s / 错误写法 5.042s。
//
//  ② 逐段裁剪的 `so_/du_` 必须写在**图层组件**里（与 fl_splice 同格，或紧随其后单独成格）。
//     写进 `fl_layer_apply` 那一格会被静默忽略（实测期望 5s、实得 8.042s = 整段被接上）。
//     机理见官方文档：在 fl_splice 语境下 `fl_layer_apply` 那格的 `so_` 有**特殊含义
//     「拼到最前面」**，那里根本不是放裁剪参数的地方 —— 所以本文件**永远不往
//     fl_layer_apply 上挂任何参数**。
//
//  ③ `br_<码率>` 完全无效（实测与不写时逐字节相同）。画质只能靠 `q_auto:<档>`。
//
// 还有一条**响亮**的（会 400，不是静默）：所有被拼接的素材**尺寸必须完全一致**
// （`Concatenated videos sizes don't match`）。所以每一格都无条件带上 `c_fill,w_,h_`，
// 横竖混排靠它归一 —— 少写一格就是整单失败，而不是悄悄裁错。
const { cloudinary } = require("../config/cloudinary");

/** 成片段落在 Cloudinary 里的家。与 videoAsset.uploadVideoBuffer 的 folder 是同一个字符串 */
const BRANCH_VIDEO_FOLDER = "ideahub/branch-videos";

/**
 * 合并的产品边界。**上限只有这一处**（CLAUDE.md「上限自己抄一份」那条坑的同款防线）：
 * 报价/校验/切片如果各写一个数，改上限时改一处漏三处不会有任何症状。
 * · maxClips 12：产品上限是 5 段，留一倍余量给"用户把一段切成几刀"（实测 24 段也拼得动，
 *   但那已经不是我们的产品形态，不如卡在能解释得清的地方）。
 * · maxTotalSec 300：一条 5 分钟的成片按实测约 0.4 credits，免费版月配额 25 —— 再长就该
 *   先谈生意而不是先出片。
 * · minClipSec 0.2：短于 5 帧的片段拼进去没有意义，还会让时长自检的误差盖过信号。
 * · maxEdge 1920：输出边长上限。变换按**输出**秒数与分辨率计费，不设上限等于给账单开洞。
 */
const COMPOSE_LIMITS = Object.freeze({
  maxClips: 12,
  minClipSec: 0.2,
  maxTotalSec: 300,
  maxEdge: 1920,
  minEdge: 64,
});

/** 画质档。默认 good（实测 ≈2.2Mbps @704×1248），best ≈3.4Mbps（体积 +54%，带宽也是钱）。
 *  源片本身 11Mbps —— 走 Cloudinary 必然重编码，这是方案的已知代价，不是 bug。 */
const QUALITY = Object.freeze({ good: "q_auto:good", best: "q_auto:best" });

/** public_id 里的斜杠在**图层引用**里必须换成冒号；URL 路径里的那份保持斜杠（官方规则） */
function layerRef(publicId) {
  return String(publicId).replace(/\//g, ":");
}

/**
 * 这个 public_id 是不是「本账号的成片段落」。
 *
 * ★ 用**形状整体匹配**而不是 startsWith(userId)（同 templateVideoAsset.ownBaseRe 的理由）：
 *   光判前缀的话，文件名里混别的字符就能拼花样。branch-videos 下只有两个生成方，
 *   形状都是 `<userId>-<毫秒>-<后缀>`：
 *     · 出片即转存（services/arkTransfer）→ `<id>-<ts>-seg`
 *     · 发布时转存（controllers/branchVideo.nextKey）→ `<id>-<ts>-<序号>-<slug>`
 *     · 本文件产出的成片 → `<id>-<ts>-merged`（合并的结果还能再被合并，形状要认得出自己）
 * ★ 为什么必须判归属：不判的话，任何登录用户拿到别人的 public_id 就能把别人的成片
 *   拼成自己的作品，还顺手烧我们的变换配额（同 resolveR2v 那道闸的理由）。
 */
function ownBranchVideoPublicId(rawPublicId, userId) {
  const publicId = String(rawPublicId || "").slice(0, 300);
  const marker = `${BRANCH_VIDEO_FOLDER}/`;
  if (!publicId.startsWith(marker)) return null;
  const base = publicId.slice(marker.length);
  if (!base || base.includes("/")) return null; // folder 后必须正好一个文件段
  const clean = base.replace(/\.[A-Za-z0-9]+$/, "");
  if (!new RegExp(`^${String(userId)}-\\d+(?:-[A-Za-z0-9-]{1,48})?$`).test(clean)) return null;
  return `${BRANCH_VIDEO_FOLDER}/${clean}`;
}

/**
 * 「这条地址是不是我们成片目录下的投递地址」—— **不问归属**。
 * ★ 只用来把两种失败分开说（"素材还没转存到位" vs "这段不是你的"）：混成一句的话，
 *   归属不对的用户会照着"稍等重试"一直试到放弃。归属判据仍然只有下面那一处。
 * ★ 只认**不带变换**的地址：段落的 videoUrl 就是转存时拿到的 secure_url；
 *   带变换的地址进来说明调用方在自己拼变换 —— 那是我们拼的活儿，不收。
 * @returns {string|null} 文件段（不含目录）；null = 不是
 */
function branchVideoName(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // /<cloud>/video/upload/[v123/]ideahub/branch-videos/<name>
  const m = parsed.pathname.match(
    new RegExp(`^/[^/]+/video/upload/(?:v\\d+/)?${BRANCH_VIDEO_FOLDER}/([^/]+)$`),
  );
  return m ? m[1] : null;
}

/** 上一条的布尔视图（形状判断只活在 branchVideoName 一处） */
function isBranchVideoUrl(rawUrl) {
  return branchVideoName(rawUrl) !== null;
}

/**
 * 段落地址 → public_id。三重白名单与 templateVideoAsset.parseOwnTemplateVideoUrl 同款
 * （host + 目录 + 归属），少一道就多一条绕行路。
 * @returns {{publicId:string}|null}
 */
function parseOwnBranchVideoUrl(rawUrl, userId) {
  const name = branchVideoName(rawUrl);
  if (!name) return null;
  const publicId = ownBranchVideoPublicId(`${BRANCH_VIDEO_FOLDER}/${name}`, userId);
  return publicId ? { publicId } : null;
}

/** 秒数 → 变换串里的写法。三位小数够用（24fps 一帧 = 0.042s），再多只是让 URL 变长 */
function sec(n) {
  return String(Math.round(Number(n) * 1000) / 1000);
}

/**
 * 拼接后**应该**有多长 —— 时长自检的期望值。
 * ★ 这是整条链路的**防静默失败判据**（铁律八）：上面三个陷阱的共同特征是
 *   「200 + 无错误头 + 产物是另一个东西」，而它们在时长上全都露馅
 *   （画中画 = 只有基片那么长；裁剪被忽略 = 比期望长）。所以产物落地后必须比对这个数，
 *   对不上就整单判失败，绝不把一条"看着像成片"的东西交出去。
 */
function expectedDurationSec(clips) {
  return clips.reduce((s, c) => s + (c.endSec - c.startSec), 0);
}

/**
 * 把「一段视频 + 它的裁剪」拼成一个组件的参数串（不含 l_video/fl_splice 本身）。
 * 顺序固定：归一尺寸 → 静音（可选）→ 裁剪。参数在组件内的顺序 Cloudinary 不敏感，
 * 固定下来只是为了让两条路（基片/图层）长得一样、diff 时看得出差别。
 */
function clipParams(clip, width, height, mute) {
  return [
    `c_fill,w_${width},h_${height}`,
    ...(mute ? ["ac_none"] : []),
    `so_${sec(clip.startSec)},du_${sec(clip.endSec - clip.startSec)}`,
  ].join(",");
}

/**
 * 变换串 —— 本模块的核心产出。
 *
 * 形状（每一格的位置都是实测钉死的，别调换）：
 *   <基片: 画质,归一,[静音],裁剪>
 *   /fl_splice,l_video:<第2段>/<归一,[静音],裁剪>/fl_layer_apply      ← 每多一段就多这么一组
 *   /l_audio:<BGM>,du_,[e_loop:N],[e_volume:V]/fl_layer_apply          ← 有 BGM 才有这一格
 *
 * @param {object} o
 * @param {Array<{publicId:string,startSec:number,endSec:number}>} o.clips 已过归属校验，≥1 段
 * @param {number} o.width  输出宽（偶数）
 * @param {number} o.height 输出高（偶数）
 * @param {"good"|"best"} [o.quality]
 * @param {{publicId:string, durationSec:number, volume:number, replace:boolean}} [o.bgm]
 * @returns {string} 变换串（不含 host / public_id）
 */
function buildComposeTransform({ clips, width, height, quality = "good", bgm = null }) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error("compose: 至少要一段");
  // ★ 原声静音要**每一格都写**：实测 `ac_none` 只作用于它所在的那一格 ——
  //   只写基片那格的话，被拼接的段落的声音照样进成片（用户选了"只要 BGM"，
  //   却听见原声与 BGM 混在一起，而且不报错）。
  const mute = !!(bgm && bgm.replace);
  const [first, ...rest] = clips;

  const head = [QUALITY[quality] || QUALITY.good, clipParams(first, width, height, mute)].join(",");

  // ★★ fl_splice 与 l_video 同格（陷阱①）；裁剪单独成格（官方形状，实测等价于同格）；
  //    fl_layer_apply **裸着**，一个参数都不挂（陷阱② —— 那一格的 so_ 是"拼到最前面"的意思）。
  const layers = rest.map(
    (c) => `fl_splice,l_video:${layerRef(c.publicId)}/${clipParams(c, width, height, mute)}/fl_layer_apply`,
  );

  const parts = [head, ...layers];

  if (bgm) {
    // BGM 循环铺满：`e_loop:N` = **额外重复 N 次**（共播 N+1 遍）——
    // 2026-08-21 对照实测：3 秒素材 du_3 单独用得 3.064s、e_loop:1 得 6.064s、
    // e_loop:3 得 10.147s（被片长截断）。
    // ⚠ 官方文档对"音频图层能不能循环"只字未提，这是**实测行为不是契约**：
    //   所以产物落地后那道"音轨够不够长"的自检不能省（见 service 的 verify）。
    const total = expectedDurationSec(clips);
    const dur = Math.max(0.1, Number(bgm.durationSec) || 0);
    const loops = dur > 0 ? Math.max(0, Math.ceil(total / dur) - 1) : 0;
    // volume：客户端给 0..1（剪辑页那个滑块），Cloudinary 收的是 -100..400 的百分比增量。
    // 1.0 → 0（原样）、0.5 → -50、0 → mute。实测单调生效（取纯音频比字节：
    // -100 得 40,971 字节的近似静音，默认 172,587，+100 得 181,011）。
    const vol = Math.max(-100, Math.min(400, Math.round((Number(bgm.volume) - 1) * 100)));
    const bgmParams = [
      `l_audio:${layerRef(bgm.publicId)}`,
      `du_${sec(Math.min(dur, total))}`,
      ...(loops > 0 ? [`e_loop:${loops}`] : []),
      ...(vol !== 0 ? [`e_volume:${vol}`] : []),
    ].join(",");
    parts.push(`${bgmParams}/fl_layer_apply`);
  }

  return parts.join("/");
}

/**
 * 第一段的**原始**投递地址（不带任何变换）—— 合并时喂给上传接口的"源"。
 *
 * ★★ 为什么是"原始地址 + 变换走 API 参数"，而不是"拼一条带变换的投递地址再让它去抓"
 *   （2026-08-21 三种做法都实测过，这条是唯一没有副作用的）：
 *   · 变换作为**入站变换**（raw_transformation）随上传请求发出，请求本身是签过名的 API 调用，
 *     所以账号将来打开 strict transformations（应该打开：实测匿名任意变换返回 200，
 *     等于谁知道 public_id 都能烧我们的月配额）这条路**完全不受影响**；
 *   · 不产生任何派生资源 —— 另外两种做法都会在第 1 段上挂一份中间产物，占存储还要另外清；
 *   · 一次调用就落地，且落下来的是**常规 MP4**。这一条最要紧：如果让 Cloudinary 去抓一条
 *     还没生成过的变换地址，它抓到的是"边生成边发"的**分片 MP4**，那份会被原样存成成片 ——
 *     容器里没有样本表，播放器多半读不出时长（进度条直接废掉），而且是永久的。
 *     实测三条路的产物容器：入站变换=常规、先焐热再抓=常规、直接抓冷地址=**分片**。
 */
function buildSourceUrl(publicId) {
  const cloud = cloudinary.config().cloud_name;
  if (!cloud) return null; // 没配云存储：调用方整句报出去，别拼一个 undefined 的地址
  return cloudinary.url(publicId, { resource_type: "video", secure: true, format: "mp4" });
}

module.exports = {
  BRANCH_VIDEO_FOLDER,
  COMPOSE_LIMITS,
  QUALITY,
  layerRef,
  ownBranchVideoPublicId,
  isBranchVideoUrl,
  parseOwnBranchVideoUrl,
  expectedDurationSec,
  buildComposeTransform,
  buildSourceUrl,
};
