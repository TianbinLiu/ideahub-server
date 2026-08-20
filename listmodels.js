require("dotenv").config({ path: [".env", process.env.APP_ENV_LOCAL].filter(Boolean), quiet: true });
(async () => {
  const key = process.env.ARK_API_KEY;
  if (!key) return console.log("no key");
  const r = await fetch("https://ark.cn-beijing.volces.com/api/v3/models?page_size=200", { headers: { Authorization: `Bearer ${key}` } }).catch((e) => null);
  if (!r) return console.log("fetch failed");
  const j = await r.json().catch(() => ({}));
  const names = (j.data || j.items || []).map((m) => m.id || m.name).filter(Boolean);
  console.log("total=" + names.length);
  for (const n of names) if (/seedance|minimax|hailuo|video/i.test(n)) console.log(n);
})().catch((e) => console.log("ERR " + e.message));
