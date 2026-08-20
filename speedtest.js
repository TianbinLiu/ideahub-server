require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
const { callArk } = require("./src/services/arkGateway.service");
(async () => {
  const st = await callArk({ path: "/contents/generations/tasks/cgt-20260820151343-zmz6p", method: "GET", timeoutMs: 30000 });
  const j = JSON.parse(st.text || "{}");
  const url = j.content && j.content.video_url;
  if (!url) return console.log("拿不到 video_url（可能已过期）status=" + j.status);
  console.log("host=" + new URL(url).hostname);
  const t0 = Date.now();
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  const dt = (Date.now() - t0) / 1000;
  console.log(`PC→TOS 直连: ${r.status} ${(buf.length / 1048576).toFixed(1)}MB ${dt.toFixed(1)}s = ${(buf.length / 1048576 / dt).toFixed(2)} MB/s`);
})().catch((e) => console.log("ERR " + e.message));
