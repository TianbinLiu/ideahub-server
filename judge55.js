// 真机那发 1.8M 挂满出片（hjmq8）：拉成片 → 传 Cloudinary → 抽 8 帧判读
require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
const fs = require("fs");
require("./src/config/cloudinary");
const cloudinary = require("cloudinary").v2;
const { buildOutFrameUrl } = require("./src/utils/templateVideoAsset");
const b = require("./src/services/blockoutize.service");
const { callArk } = require("./src/services/arkGateway.service");
const ID = "cgt-20260818140026-hjmq8";
const OUT = process.env.TMPDIR || ".";
(async () => {
  const r = await callArk({ path: `/contents/generations/tasks/${ID}`, method: "GET", timeoutMs: 30000 });
  const j = JSON.parse(r.text || "{}");
  if (j.status !== "succeeded") return console.log("[x] 还没好：" + j.status);
  console.log("[x] usage=" + JSON.stringify(j.usage || {}));
  const vid = j.content && j.content.video_url;
  if (!vid) return console.log("[x] succeeded 但没有 video_url");
  const local = `${OUT}/full55.mp4`;
  const rr = await fetch(vid);
  fs.writeFileSync(local, Buffer.from(await rr.arrayBuffer()));
  console.log("[x] 已下载 " + fs.statSync(local).size + " bytes");
  const up = await cloudinary.uploader.upload(local, { folder: "ideahub/tmp-drifttest", resource_type: "video", timeout: 300000 });
  console.log("[x] 成片 publicId=" + up.public_id + " dur=" + up.duration);
  for (const s of [0.5, 2, 4, 6, 8, 10, 12, 14]) {
    const f = await b.fetchFrameDataUrl(buildOutFrameUrl(up.public_id, Math.min(s, up.duration - 0.1), undefined, 1024));
    if (f.ok) {
      fs.writeFileSync(`${OUT}/f55-${String(s).replace(".", "_")}.jpg`, Buffer.from(f.dataUrl.split(",")[1], "base64"));
      console.log(`[x] 抽出 ${s}s`);
    } else console.log(`[x] ${s}s 抽帧失败`);
  }
})().catch((e) => console.log("[x] ERR " + (e && e.message)));
