// src/services/videoAsset.service.js
// 方舟成片 → 永久地址（Cloudinary）的**唯一**实现。两个调用方：
//   ① 发布时的资源转存（controllers/branchVideo.controller 的 transferVideo）——老路，兜底；
//   ② 出片后立即转存（routes/ark.routes 的 POST /transfer-video）——2026-08-20 加的新路。
//
// ★ 为什么要有②：videoUrl 原来一直揣着方舟 TOS 直链（cn-beijing）到发布才转存，
//   而预览与合并都在发布之前。跨境用户（实测美国 Cricket 手机）直连 TOS 的下载速度
//   （PC 实测 1.06 MB/s）低于成片码率（15s 720p ≈ 1.33 MB/s）——<video> 永远缓冲
//   不到能连续播（黑屏转圈、不报错），合并的 120s 代理抓取两次都拉不完 20MB
//   （用户看到的是「合并失败：The user aborted a request」）。出片后马上换成
//   Cloudinary（全球边缘 CDN），预览/合并/发布三条路一起变快，24h 过期坑也没了。
//
// ★ 从 branchVideo.controller 原样搬来，行为一个字没改（那边改成 require 这里）。
//   抄一份的话，两处的域名表/上限/超时迟早各改各的——而漂移没有任何症状，
//   只表现为"同一条链接发布时能转存、出片时却说 host 不认"。
const { cloudinary } = require("../config/cloudinary");

/** 成片段落在 Cloudinary 里的家 —— **这个字符串只有这一处**（写入方持有它）。
 *  校验方（utils/videoCompose 的归属判据）从这里 import：两处各写一份的话，
 *  哪天改了目录，写进去的和认得出的就是两个地方，而且都不报错 —— 表现是
 *  "刚转存好的段落，合并时说不是你的素材"（铁律六）。 */
const BRANCH_VIDEO_FOLDER = "ideahub/branch-videos";

// 下载方舟视频的上限与超时（可用环境变量覆盖）
const MAX_VIDEO_BYTES = Number(process.env.BRANCH_VIDEO_MAX_BYTES || 80 * 1024 * 1024);
const VIDEO_FETCH_TIMEOUT_MS = Number(process.env.BRANCH_VIDEO_FETCH_TIMEOUT_MS || 60_000);

// 火山方舟 / TOS 视频域名特征：命中则必须转存，否则 24h 后链接失效
const ARK_HOST_PATTERNS = [
  /(^|\.)volces\.com$/i,
  /(^|\.)volccdn\.com$/i,
  /(^|\.)byteimg\.com$/i,
  /(^|\.)bytedance\.com$/i,
  /(^|\.)ivolces\.com$/i,
  /tos-[a-z0-9-]+\./i,
];

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isArkVideoUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const host = new URL(value.trim()).hostname;
    return ARK_HOST_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/**
 * 这份 mp4 / mov 的视频轨是不是 H.265（样本描述是 `hvc1` / `hev1`）。
 * ★ 只看 `stsd` 盒子里第一条样本描述的 fourcc（`stsd` 类型之后：版本+标志 4、条目数 4、条目大小 4，再 4 字节就是它），
 *   不在整份文件里搜 "hvc1" —— mdat 里的随机字节会撞上。认错的代价只是多转一次码（或少转一次 = 与改之前一样）。
 */
function isHevcMp4(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  for (let at = 0; ; ) {
    const i = buf.indexOf("stsd", at, "latin1");
    if (i === -1) return false;
    if (i + 20 <= buf.length) {
      const fourcc = buf.toString("latin1", i + 16, i + 20);
      if (fourcc === "hvc1" || fourcc === "hev1") return true;
    }
    at = i + 4;
  }
}

/**
 * H.265 成片存进图床时转成 H.264 的入站变换（与 videoCompose 的合并同一种做法：随签名的上传请求发出，
 * 存下来的就是转好的常规 MP4，不产生派生资源）。
 * ★★ 为什么要转（2026-10-07 付费实测）：电影级「样片」定稿出来的 1080p 是 **HEVC Main 10**（10 bit，方舟官方：2.5 的 1080p 一律 10 bit），
 *   App 的 WebView（模拟器 Chrome 133）上 `canPlayType('hvc1.2.4…')` 为空、放起来**只有声音、一帧画面都解不出**（videoWidth 0）；
 *   而 App 的截帧、合并（Media3 走系统解码器）读的都是同一种解码能力。没有 10 bit 解码器的手机上，这一段付了最贵的钱、是黑的。
 * ★ 质量取 `q_auto:good`（与合并的 good 档同一个旋钮）。Cloudinary 出的 H.264 是 8 bit。
 */
const H264_TRANSCODE = "vc_h264,q_auto:good";

function uploadOnce(buffer, key, opts, rawTransformation) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: BRANCH_VIDEO_FOLDER,
        public_id: `${key}`,
        resource_type: "video",
        // 后台转存（arkTransfer.service）传 timeoutMs=300s：ECS → Cloudinary 跨境传
        // 20MB 级成片可能过分钟，SDK 默认 60s 会掐死在半途。发布老路不传 = 行为不变。
        ...(opts && opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
        ...(rawTransformation ? { raw_transformation: rawTransformation } : {}),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result || {});
      }
    );
    stream.end(buffer);
  });
}

/**
 * 成片 → 图床，回永久地址。H.265 的先试着转成 H.264 存（见 H264_TRANSCODE）；转码那一发失败就**按原样再存一次**并吼一声 ——
 * 退回的就是改之前的行为（存原片），不会因为多了这一步把转存弄丢（转存不成 = 24 小时后方舟链接过期、这一段就没了）。
 */
async function uploadVideoBuffer(buffer, key, opts) {
  if (isHevcMp4(buffer)) {
    try {
      const r = await uploadOnce(buffer, key, opts, H264_TRANSCODE);
      const codec = r?.video?.codec;
      const pix = r?.video?.pix_format;
      // 转出来的不是 8 bit H.264（Cloudinary 哪天改了缺省）只吼不拦：存下来的至少是一份能用的永久地址
      if (codec && (!/^h264/i.test(codec) || /10/.test(String(pix || "")))) {
        console.warn(`[video-asset] ${key} 转码结果是 ${codec} / ${pix}，不是 8 bit H.264`);
      } else {
        console.log(`[video-asset] ${key} H.265 → ${codec || "?"} / ${pix || "?"}`);
      }
      return r?.secure_url || "";
    } catch (e) {
      console.warn(`[video-asset] ${key} H.265 转 H.264 没成，按原样存：`, (e && e.message) || e);
    }
  }
  const r = await uploadOnce(buffer, key, opts, null);
  return r?.secure_url || "";
}

async function downloadToBuffer(url, opts) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (Node >= 18 required)");
  const controller = new AbortController();
  // 后台转存传 timeoutMs=300s（没人在线上等它，宁可慢慢搬成——2026-08-21 真机链路
  // 复盘：ECS 拉 TOS 跨境本身就可能超过默认的 60s）。发布老路不传 = 行为不变。
  const timer = setTimeout(() => controller.abort(), (opts && opts.timeoutMs) || VIDEO_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const declared = Number(resp.headers.get("content-length") || 0);
    if (declared && declared > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${declared} > ${MAX_VIDEO_BYTES}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error("empty body");
    if (buf.length > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${buf.length} > ${MAX_VIDEO_BYTES}`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  BRANCH_VIDEO_FOLDER,
  MAX_VIDEO_BYTES,
  VIDEO_FETCH_TIMEOUT_MS,
  ARK_HOST_PATTERNS,
  isHttpUrl,
  isArkVideoUrl,
  isHevcMp4,
  H264_TRANSCODE,
  uploadVideoBuffer,
  downloadToBuffer,
};
