// 第十四发：等最新任务出现 → 盯到终态
require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
const { callArk } = require("./src/services/arkGateway.service");
const AFTER = Number(process.env.AFTER_TS); // 只认这个时刻之后创建的任务
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let id = null;
  for (let i = 0; i < 20 && !id; i += 1) {
    const r = await callArk({ path: "/contents/generations/tasks?page_size=5", method: "GET", timeoutMs: 30000 }).catch(() => null);
    const j = r ? JSON.parse(r.text || "{}") : {};
    for (const t of j.items || []) if (t.created_at * 1000 > AFTER) { id = t.id; break; }
    if (!id) await sleep(15000);
  }
  if (!id) return console.log("没等到新任务（App 侧可能在创建前就失败了）");
  console.log("受理 id=" + id);
  const t0 = Date.now();
  let last = "";
  for (let i = 0; i < 160; i += 1) {
    await sleep(30000);
    const st = await callArk({ path: `/contents/generations/tasks/${id}`, method: "GET", timeoutMs: 30000 }).catch(() => null);
    const sj = st ? JSON.parse(st.text || "{}") : {};
    const s = sj.status || "poll-error";
    const mins = Math.round((Date.now() - t0) / 60000);
    if (s !== last) { console.log(`${s} @${mins}min`); last = s; }
    else if (i % 10 === 0) console.log(`仍在 ${s} @${mins}min`);
    if (s === "succeeded") { console.log("成片就绪 usage=" + JSON.stringify(sj.usage || {})); return; }
    if (s === "failed" || s === "cancelled") { console.log("失败 " + JSON.stringify(sj.error || {}).slice(0, 200)); return; }
  }
  console.log("盯了 80 分钟仍未终态 id=" + id);
})().catch((e) => console.log("ERR " + e.message));
