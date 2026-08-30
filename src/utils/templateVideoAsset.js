// src/utils/templateVideoAsset.js
// 「这段托管视频是谁的、地址长什么样」—— **这条规则的唯一实现**（铁律六）。
//
// 在此之前它有三份：branchTemplate.routes 的 parseOwnTemplateVideoUrl / ownedCloudinaryAsset、
// uploads.routes 里 DELETE 孤儿回收那个手写的 `startsWith(前缀)`。三份里只要有一份松了，
// 就有一条绕行路（拿别人的资产登记模板 / 从侧门删掉别人在用的视频），而且都不报错。
// 白模 V2 又要在 ark.routes 的 resolveR2v 里判第四次 —— 所以先提成公共模块再动。
//
// ★★ 白模 V2 新增的「裁剪变换 URL」也收在这里：
//   服务端按用户框选的四组数（startSec/durSec/crop）拼一条 Cloudinary 变换地址，
//   **客户端永远碰不到这个 URL**。为什么较真：r2v 的计价输入时长就是 `du_` 那个数
//   （方舟公式把输入视频时长计进 token），能让客户端拼 URL 就等于让用户自己标价。
//   拼与解各只有一处（buildClipUrl / parseOwnClipUrl），形状对不上一律不认。
const { cloudinary } = require("../config/cloudinary");

/** 白模/原始素材视频在 Cloudinary 里的家。与 uploads.routes 的上传 folder 是同一个字符串 ——
 *  这里的白名单校验与那边的落盘位置如果分叉，所有新模板都会 400，且两边各自看着都没错 */
const TEMPLATE_VIDEO_FOLDER = "ideahub/template-videos";

/** 上传时服务端生成的 public_id 形状：`${userId}-${Date.now()}`。
 *  ★ 用**形状整体匹配**而不是 startsWith(userId)：光判前缀的话文件名里混别的字符就能拼花样，
 *    收成 `^<本人id>-\d+$` 之后没有任何拼接余地。 */
function ownBaseRe(userId) {
  return new RegExp(`^${String(userId)}-\\d+$`);
}

/**
 * 这个 public_id 是不是「本账号传到模板视频目录」的资产。
 * @returns {string|null} 归一化后的 public_id（不带扩展名）；null = 不是
 */
function ownTemplateVideoPublicId(rawPublicId, userId) {
  const publicId = String(rawPublicId || "").slice(0, 300);
  const marker = `${TEMPLATE_VIDEO_FOLDER}/`;
  if (!publicId.startsWith(marker)) return null;
  const base = publicId.slice(marker.length);
  // folder 后必须正好一个文件段（多一层斜杠 = 伪造的形状，不是我们生成的）
  if (!base || base.includes("/")) return null;
  const clean = base.replace(/\.[A-Za-z0-9]+$/, "");
  if (!ownBaseRe(userId).test(clean)) return null;
  return `${TEMPLATE_VIDEO_FOLDER}/${clean}`;
}

/**
 * videoUrl 的三重白名单：host + 目录 + public_id 归属。
 * 三道都要，缺一道就有一条绕行路：
 *   只校 host   → 能把别人的任何 Cloudinary 资源（头像、别人的模板视频）注册成自己的模板；
 *   只校目录   → 能把 /media 传的 webm（r2v 根本不认的格式）注册进来；
 *   只校归属   → 归属判据在别的 folder 里同样成立，挡不住"拿自己传的头像当模板视频"。
 * @returns {{ publicId: string } | null} null = 不合格
 */
function parseOwnTemplateVideoUrl(rawUrl, userId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  // ① host：只认 Cloudinary 的分发域（https）。new URL 已做路径归一化（../ 之类被折掉）
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // ② 目录：必须落在模板视频专用 folder 里
  const marker = `/${TEMPLATE_VIDEO_FOLDER}/`;
  const idx = parsed.pathname.indexOf(marker);
  if (idx === -1) return null;
  const name = parsed.pathname.slice(idx + marker.length);
  if (!name || name.includes("/")) return null;
  // ③ 归属
  const publicId = ownTemplateVideoPublicId(`${TEMPLATE_VIDEO_FOLDER}/${name}`, userId);
  return publicId ? { publicId } : null;
}

/**
 * 封面回收用：这个 https URL 是不是「本账号传到我们 Cloudinary 空间」的资产。
 * 只用于 DELETE 时的 best-effort 回收 —— 认不出（外链、别人的资产）就不动它。
 * @returns {{ publicId: string, resourceType: string } | null}
 */
function ownedCloudinaryAsset(rawUrl, userId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // 路径形如 /<cloud>/<resource_type>/upload/v123/ideahub/<folder>/<userId>-<ts>.<ext>
  const m = parsed.pathname.match(/^\/[^/]+\/(image|video)\/upload\/(?:v\d+\/)?(ideahub\/[^/]+\/([^/]+))$/);
  if (!m) return null;
  const base = m[3].replace(/\.[A-Za-z0-9]+$/, "");
  if (!ownBaseRe(userId).test(base)) return null;
  return { publicId: m[2].replace(/\.[A-Za-z0-9]+$/, ""), resourceType: m[1] };
}

/**
 * 作品/卡片删除时**可以回收**的 Cloudinary 目录白名单。
 *
 * ★ 刻意不含 `template-videos`：那条有自己的四道 in-use 闸与级联（见 branchTemplate.routes）。
 * ★ 刻意不含 `avatars`：头像不随作品走，删作品把头像删了是另一种事故。
 */
const RECYCLABLE_FOLDERS = ["branch-frames", "branch-videos", "content-images", "workshop-media"];

/**
 * 上面这批目录里，服务端生成的 public_id 形状是 `${userId}-${ts}` **再带若干后缀段**
 * （`-1-cover-<ts>` / `-seg` / `-<seq>-<slug>-<ts>`，见 branchVideo.nextKey 与
 * videoAsset.uploadVideoBuffer / arkTransfer 的 cldKey）。
 *
 * ⚠ **不能复用 `ownBaseRe`**：那条是 `^<id>-\d+$`，认得出 content-images/workshop-media，
 *   认不出 branch-frames / branch-videos。用错的表现是"功能上线了、代码看着对、
 *   月底用量一点没降"，而没回收到的恰恰是**体积最大**的那批（成片）。
 * ⚠ 反过来也不能把 `ownBaseRe` 放宽成这个：模板那条严格形状是**安全属性**
 *   （没有拼接余地），放宽它等于给"拿别人的资产登记模板"开一条缝。两条各管各的。
 */
function ownRecyclableBaseRe(userId) {
  // ⚠ `\\d` 必须写两个反斜杠：模板字符串里的 `\d` 是**无效转义**，运行时退化成字母 d，
  //   于是这条正则永远匹配不上，而且**零报错**（CLAUDE.md 那格坑，本次又栽了一次）。
  return new RegExp(`^${String(userId)}-\\d+(?:-[A-Za-z0-9_-]+)*$`);
}

/**
 * 这个 https URL 是不是「**这个账号**传到我们这几个目录里」的资产 —— 删除时据此回收。
 *
 * @param {string} rawUrl
 * @param {string} userId
 * @param {string[]} folders **必填**，无默认值。给默认值的话，新调用点漏传就悄悄退回
 *   "什么目录都认"，而那正是这条最危险的失败方式：删一个号会顺手 destroy 掉别人还在
 *   用的东西，且零报错（与 shareBlockReason 的方向参数必填同一条纪律）。
 * @returns {{ publicId: string, resourceType: string } | null} null = 不认（外链 / 别人的资产 / 不在白名单目录）
 */
function ownedRecyclableAsset(rawUrl, userId, folders) {
  if (!Array.isArray(folders) || folders.length === 0) {
    throw new Error("ownedRecyclableAsset: folders 必须显式给（见该函数的 ⚠）");
  }
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // 路径形如 /<cloud>/<resource_type>/upload/v123/ideahub/<folder>/<base>.<ext>
  // ★ resourceType 从**路径段**取，绝不写死 "video"：workshop-media 一个目录里 image/video
  //   都有，写死的表现是"合并成片删得掉、封面删不掉"，而 Cloudinary 对不存在的资源
  //   回 "not found" 不报错 —— 又是零症状。
  const m = parsed.pathname.match(/^\/[^/]+\/(image|video)\/upload\/(?:v\d+\/)?ideahub\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const [, resourceType, folder, file] = m;
  if (!folders.includes(folder)) return null;
  const base = file.replace(/\.[A-Za-z0-9]+$/, "");
  if (!ownRecyclableBaseRe(userId).test(base)) return null;
  return { publicId: `ideahub/${folder}/${base}`, resourceType };
}

// ── 裁剪变换（白模 V2）────────────────────────────────────────────────
//
// 2026-08-15 实测（F8）：`so_<秒>,du_<秒>,c_crop,x_,y_,w_,h_` 一条变换同时做
// **时间截取**与**画面裁剪**，Cloudinary 侧零成本、手机不重编码。
// 白模 V2 的整条链路就靠它把「用户传的任意长视频」变成「方舟 edit 吃得下的那一段」：
//   时长 ∈[4,30]（F1）、宽×高 ≥407,696、边长 ∈[300,6000]、比例 ∈[0.4,2.5]（F3）。
//
// ★ 形状写死成**一个组件、固定顺序**（不是 cloudinary.url 自己排的多组件），
//   因为 resolveR2v 要从 URL 里把 `du_` 那个数解回来当计价输入时长 ——
//   拼与解必须是同一种形状，否则「服务端拼得出、服务端自己认不出」。
const CLIP_TRANSFORM_RE = /^so_(\d+),du_(\d+),c_crop,x_(\d+),y_(\d+),w_(\d+),h_(\d+)$/;

/** 四组数 → 规范变换串。参数必须已经是非负整数（调用方先过 zod） */
function clipTransform({ startSec, durSec, crop }) {
  return `so_${startSec},du_${durSec},c_crop,x_${crop.x},y_${crop.y},w_${crop.w},h_${crop.h}`;
}

/**
 * 拼一条「裁剪后那一段」的投递地址。
 * @param {string} publicId 已过归属校验的 public_id
 * @param {{startSec,durSec,crop}} clip 四组数（整数）
 * @param {number|string} [version] Cloudinary 资源版本号。带上它才是规范形态 ——
 *   同一个 public_id 被覆盖上传后旧变换会缓存在 CDN 上，不带版本可能投递到旧内容。
 * @returns {string}
 * ★ 强制 `.mp4`：方舟 r2v 只认 mp4/mov，而用户传的可能是 mov —— 让 Cloudinary 在
 *   投递时转出 mp4，比在上传口要求用户自己转码诚实得多。
 */
function buildClipUrl(publicId, clip, version) {
  const cloud = cloudinary.config().cloud_name;
  if (!cloud) return null; // 没配云存储：调用方整句报出去，不拼一个 `undefined` 的地址
  const v = version ? `v${version}/` : "";
  return `https://res.cloudinary.com/${cloud}/video/upload/${clipTransform(clip)}/${v}${publicId}.mp4`;
}

/**
 * 抽一帧当图（给 chat vision「先看」用，F4 第一步）。
 * 与上面同一条裁剪，只是把时间点定死并转成 jpg；再缩到 768 宽 ——
 * 视觉只需要认出"画面里有哪几个人、长什么样"，喂 4K 原图只是让请求更慢更贵。
 */
function buildFrameUrl(publicId, { atSec, crop }, version) {
  const cloud = cloudinary.config().cloud_name;
  if (!cloud) return null;
  const v = version ? `v${version}/` : "";
  const t = `so_${atSec},c_crop,x_${crop.x},y_${crop.y},w_${crop.w},h_${crop.h}/c_scale,w_768`;
  return `https://res.cloudinary.com/${cloud}/video/upload/${t}/${v}${publicId}.jpg`;
}

/**
 * 抽帧宽度**两档，别混用**（2026-08-17 混用当场撞上 504）：
 *  · `OUT_FRAME_W_BOX` = 1024 —— 「量框」那一发。它要的是**位置精度**，而且只有**一帧**。
 *    1024 是实测过的宽度（回包 5 个框横向逐个压中）；往下调没验过，框偏了不报错，
 *    只会让用户拖到隔壁那个人身上。
 *  · `OUT_FRAME_W_ROSTER` = 768 —— 「认人」那一发。它要的是"画面里有谁"，768 够用，
 *    而且它一次要喂**最多 8 帧**。
 * ⚠ 认人那一发照 1024 喂 8 帧的话，token 量是 768 的约 1.8 倍，实测直接把上游打到
 *   **504 ark upstream TimeoutError**（T_CREATE = 150s 都没撑住）。而失败之后
 *   `parseRoles("")` 回 0，表现是一句假话：「AI 没在这段视频里认出人物」。
 *   ⇒ 两档各有各的理由，谁都别去"统一"成一个数。
 */
const OUT_FRAME_W_BOX = 1024;
const OUT_FRAME_W_ROSTER = 768;

/**
 * 抽**产物 / 作者自带参考视频**的一帧。
 *
 * ★ 与 `buildFrameUrl` 的区别不是风格：这条**不裁剪**。产物已经是最终画面，
 *   再套一次原片的 crop 会切错地方（那组 x/y/w/h 是相对**原视频**的坐标）；
 *   而框的坐标是相对"用户在 App 里看到的那一帧"归一化的，两者必须是同一个画面，
 *   差一次裁剪就是全体框整体偏移。
 * ★ `width` 默认给量框那一档（1024）—— 认人那一发**必须显式传 OUT_FRAME_W_ROSTER**。
 */
function buildOutFrameUrl(publicId, atSec, version, width = OUT_FRAME_W_BOX) {
  const cloud = cloudinary.config().cloud_name;
  if (!cloud) return null;
  const v = version ? `v${version}/` : "";
  return `https://res.cloudinary.com/${cloud}/video/upload/so_${atSec},c_scale,w_${width}/${v}${publicId}.jpg`;
}



/**
 * 把一条裁剪变换地址解回来 —— **只认服务端自己拼得出的那一种形状**。
 *
 * ★★ 这是 resolveR2v 第二条分支（白模化那一发）的计价锚点：`du_` 那个数就是方舟
 *   实际收到的输入视频时长，Cloudinary 会照这个数投递，所以按它计价是**自洽**的
 *   （URL 同时决定了"方舟拿到多长"和"我们收多少钱"，客户端改不出"少付多得"）。
 *   反过来，**没有 `du_` 的地址一律不认**：那等于把整条原片（最长 600s）喂给方舟，
 *   而我们只会按纯任务价收 —— 输入时长一分不收，账目全瞎。
 *
 * @returns {{ publicId, startSec, durSec, crop:{x,y,w,h} } | null}
 */
function parseOwnClipUrl(rawUrl, userId) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  // /<cloud>/video/upload/<transform>/[v123/]ideahub/template-videos/<name>.mp4
  const m = parsed.pathname.match(
    new RegExp(`^/[^/]+/video/upload/([^/]+)/(?:v\\d+/)?${TEMPLATE_VIDEO_FOLDER}/([^/]+)$`),
  );
  if (!m) return null;
  const t = CLIP_TRANSFORM_RE.exec(m[1]);
  if (!t) return null;
  const publicId = ownTemplateVideoPublicId(`${TEMPLATE_VIDEO_FOLDER}/${m[2]}`, userId);
  if (!publicId) return null;
  const [, so, du, x, y, w, h] = t;
  return {
    publicId,
    startSec: Number(so),
    durSec: Number(du),
    crop: { x: Number(x), y: Number(y), w: Number(w), h: Number(h) },
  };
}

module.exports = {
  RECYCLABLE_FOLDERS,
  ownedRecyclableAsset,
  TEMPLATE_VIDEO_FOLDER,
  ownTemplateVideoPublicId,
  parseOwnTemplateVideoUrl,
  ownedCloudinaryAsset,
  clipTransform,
  buildClipUrl,
  buildOutFrameUrl,
  OUT_FRAME_W_BOX,
  OUT_FRAME_W_ROSTER,
  buildFrameUrl,
  parseOwnClipUrl,
};
