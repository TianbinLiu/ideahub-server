"use strict";
/**
 * 老师人格 —— 教材原件的取回：把 Cloudinary 的签名下载地址**流式转发**给客户端，不 302。
 *
 * ★★ 为什么不 302（2026-09-28 改）：raw 资产对这个账号只有 api.cloudinary.com/…/download 这一条能取（公开投递一律 401，
 *   见 directUpload.service.directDownloadUrl 头上的实测）。浏览器里 pdf.js 是跨源 fetch：302 之后那一跳能不能过 CORS，
 *   完全取决于 Cloudinary 在 download 端点上给不给 Access-Control-Allow-Origin —— 这一点没有在真机上量过，而移植用的
 *   容器连 Cloudinary 都够不着（网络策略 403）。流式转发只依赖我们自己的 CORS（app.js 的 cors 中间件），少一个未知数；
 *   代价是字节过一遍服务器：一份讲义几 MB、只在学生打开阅读面时拉，M1 的量级付得起。真要回到 302，先在真机上量那一跳。
 * ★ Range 原样转给上游、206 与 Content-Range 原样转回：pdf.js 首发探到 Accept-Ranges + Content-Length 才会分段取；
 *   上游不认 Range 就整份 200，pdf.js 也吃得下（只是不能按需取页）。
 * ★ 客户端断开就 abort 上游 —— 否则一个人反复刷新会让服务器替他把整份文件拉 N 遍。断开只认 res 的 close
 *   （Node 16 起 req 的 close 要等响应结束才发，中途断线它不吭声）。
 * ★ 超时只管「上游多久开始应答」（首字节），不管整份传多久：几十 MB 的讲义在慢网上传几分钟是正常的。
 */
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/** 原样转回的响应头：pdf.js 靠前三个决定要不要分段取 */
const PASS_HEADERS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];
const HEAD_TIMEOUT_MS = 30_000;

async function pipeSignedDownload({ url, req, res, filename, mime, fetchImpl = fetch, headTimeoutMs = HEAD_TIMEOUT_MS }) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableFinished) ac.abort(); };
  res.on("close", onClose);
  const timer = setTimeout(() => ac.abort(), headTimeoutMs);
  let upstream;
  try {
    upstream = await fetchImpl(url, { headers: req.headers.range ? { range: req.headers.range } : {}, signal: ac.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    res.off("close", onClose);
    if (res.headersSent || res.destroyed) return;
    return res.status(502).json({ ok: false, code: "UPSTREAM", message: ac.signal.aborted ? `文件存储 ${Math.round(headTimeoutMs / 1000)} 秒内没有应答，稍后再试` : `取教材原件失败：${e.message}` });
  }
  clearTimeout(timer);
  if (upstream.status !== 200 && upstream.status !== 206) {
    res.off("close", onClose);
    try { await upstream.body?.cancel(); } catch { /* 上游的错误体读不读都行 */ }
    return res.status(502).json({ ok: false, code: "UPSTREAM", upstreamStatus: upstream.status, message: `文件存储回了 ${upstream.status}（签名地址过期或资产不在）` });
  }
  res.status(upstream.status);
  res.set("Content-Type", mime || upstream.headers.get("content-type") || "application/octet-stream");
  for (const h of PASS_HEADERS) { const v = upstream.headers.get(h); if (v) res.set(h, v); }
  res.set("Cache-Control", "private, no-store");
  // 上游给的是 attachment（下载端点），这里是给阅读面看的
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename || "material")}`);
  // cors 中间件只暴露钱包那三个头；pdf.js 要读得到这三个才会走范围请求
  res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  if (!upstream.body) { res.off("close", onClose); return res.end(); }
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (!ac.signal.aborted) res.destroy(e); // 传到一半上游断了：不能装成完整文件结束
  } finally {
    res.off("close", onClose);
  }
}

module.exports = { pipeSignedDownload, PASS_HEADERS, HEAD_TIMEOUT_MS };
