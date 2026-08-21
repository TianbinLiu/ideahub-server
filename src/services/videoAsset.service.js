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

async function uploadVideoBuffer(buffer, key, opts) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: BRANCH_VIDEO_FOLDER,
        public_id: `${key}`,
        resource_type: "video",
        // 后台转存（arkTransfer.service）传 timeoutMs=300s：ECS → Cloudinary 跨境传
        // 20MB 级成片可能过分钟，SDK 默认 60s 会掐死在半途。发布老路不传 = 行为不变。
        ...(opts && opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result?.secure_url || "");
      }
    );
    stream.end(buffer);
  });
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
  uploadVideoBuffer,
  downloadToBuffer,
};
