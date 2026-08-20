require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
const { callArk } = require("./src/services/arkGateway.service");
const ID = "cgt-20260818140026-hjmq8";
(async () => {
  let last = "";
  for (let i = 0; i < 120; i += 1) {
    const r = await callArk({ path: `/contents/generations/tasks/${ID}`, method: "GET", timeoutMs: 30000 }).catch(() => null);
    const j = r ? JSON.parse(r.text || "{}") : {};
    const s = j.status || "poll-error";
    if (s !== last) { console.log(`status=${s} t=${i * 30}s`); last = s; }
    if (s === "succeeded") { console.log("video=" + (j.content && j.content.video_url ? "yes" : "MISSING")); console.log("usage=" + JSON.stringify(j.usage || {})); return; }
    if (s === "failed" || s === "cancelled") { console.log("error=" + JSON.stringify(j.error || j).slice(0, 300)); return; }
    await new Promise((x) => setTimeout(x, 30000));
  }
  console.log("timeout-after-60min");
})().catch((e) => console.log("ERR " + e.message));
