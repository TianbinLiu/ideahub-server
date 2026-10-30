/**
 * tutorFile.service —— 教材原件的流式转发（GET /api/tutor/materials/:sha/file 不再 302）。
 * 上游用本地 http 服务器顶替 Cloudinary 的签名下载端点：整份 200、Range → 206、非 2xx、迟迟不应答四种。不碰 Mongo。
 */
const http = require("node:http");
const express = require("express");
const request = require("supertest");
const { pipeSignedDownload } = require("../src/services/tutorFile.service");

const BODY = Buffer.alloc(100_000, 7);
BODY.write("%PDF-1.7\n", 0);
let upstream; let base; const seen = [];
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range || null });
    if (req.url === "/gone") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "expired" })); }
    if (req.url === "/hang") return; // 永不应答
    const m = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range || "");
    if (m) {
      const s = Number(m[1]); const e = m[2] ? Number(m[2]) : BODY.length - 1;
      res.writeHead(206, { "content-type": "application/octet-stream", "content-range": `bytes ${s}-${e}/${BODY.length}`, "content-length": e - s + 1, "accept-ranges": "bytes", "content-disposition": "attachment; filename=x.pdf" });
      return res.end(BODY.subarray(s, e + 1));
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": BODY.length, "accept-ranges": "bytes", "content-disposition": "attachment; filename=x.pdf" });
    res.end(BODY);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${upstream.address().port}`;
});
afterAll(async () => { upstream.closeAllConnections?.(); await new Promise((r) => upstream.close(r)); });

function appFor(path, extra = {}) {
  const app = express();
  app.get("/file", (req, res) => pipeSignedDownload({ url: base + path, req, res, filename: "第一周 时延.pdf", mime: "application/pdf", ...extra }));
  return app;
}
const binary = (res, cb) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); };

describe("pipeSignedDownload", () => {
  it("整份：200 + 我们的 Content-Type / inline 文件名 / 暴露给浏览器的三个头，字节逐位相同，上游的 attachment 不外泄", async () => {
    const r = await request(appFor("/ok.pdf")).get("/file").buffer(true).parse(binary);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toBe(`inline; filename*=UTF-8''${encodeURIComponent("第一周 时延.pdf")}`);
    expect(r.headers["access-control-expose-headers"]).toBe("Content-Length, Content-Range, Accept-Ranges");
    expect(r.headers["accept-ranges"]).toBe("bytes");
    expect(r.headers["content-length"]).toBe(String(BODY.length));
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(r.body, BODY)).toBe(0);
  });
  it("Range 原样转给上游、206 与 Content-Range 原样转回（pdf.js 分段取页靠它）", async () => {
    seen.length = 0;
    const r = await request(appFor("/ok.pdf")).get("/file").set("Range", "bytes=10-19").buffer(true).parse(binary);
    expect(r.status).toBe(206);
    expect(r.headers["content-range"]).toBe(`bytes 10-19/${BODY.length}`);
    expect(r.body.length).toBe(10);
    expect(Buffer.compare(r.body, BODY.subarray(10, 20))).toBe(0);
    expect(seen[0].range).toBe("bytes=10-19");
  });
  it("上游非 2xx → 502 UPSTREAM 带上游状态码（不把 401 原样透传：那会被官网当成掉登录）", async () => {
    const r = await request(appFor("/gone")).get("/file");
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, code: "UPSTREAM", upstreamStatus: 401 });
  });
  it("上游迟迟不应答 → 到点 502，说清是存储没应答", async () => {
    const r = await request(appFor("/hang", { headTimeoutMs: 300 })).get("/file");
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("UPSTREAM");
    expect(r.body.message).toMatch(/秒内没有应答/);
  });
});
