require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean) });
const { callArk } = require("./src/services/arkGateway.service");
(async () => {
  const r = await callArk({ path: "/contents/generations/tasks?page_size=6", method: "GET", timeoutMs: 30000 });
  const j = JSON.parse(r.text || "{}");
  if (!j.items) return console.log("status=" + r.status + " " + (r.text || "").slice(0, 300));
  for (const t of j.items) console.log(`${t.id}  ${t.status}  ${t.model}  created=${new Date(t.created_at * 1000).toISOString()}`);
})().catch((e) => console.log("ERR " + e.message));
