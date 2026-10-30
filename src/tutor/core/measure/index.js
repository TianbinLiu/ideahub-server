var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var measure_exports = {};
__export(measure_exports, {
  DEFAULT_CHECKLIST: () => DEFAULT_CHECKLIST,
  ESTIMATE_CHARS_PER_TOKEN: () => ESTIMATE_CHARS_PER_TOKEN,
  PRICED_KINDS: () => PRICED_KINDS,
  WALLET_QUANTUM: () => WALLET_QUANTUM,
  anchorSummary: () => anchorSummary,
  derivePrices: () => derivePrices,
  percentile: () => percentile,
  renderDogfoodReport: () => renderDogfoodReport,
  summarizeLedger: () => summarizeLedger,
  tokensOf: () => tokensOf
});
module.exports = __toCommonJS(measure_exports);
var import_pricing = require("../generate/pricing.js");
const WALLET_QUANTUM = 400;
const ESTIMATE_CHARS_PER_TOKEN = 1.5;
const PRICED_KINDS = {
  tutor_turn: ["turn", "preview"],
  tutor_distill: ["distill"],
  tutor_extract: ["stages", "stage", "card", "scan"]
};
function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil(p / 100 * xs.length) - 1));
  return xs[i];
}
const stats = (values) => {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { n: 0, p50: null, p95: null, mean: null, max: null, sum: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  return { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), mean: Math.round(sum / xs.length), max: Math.max(...xs), sum };
};
function tokensOf(rec) {
  if (Number.isFinite(rec.totalTokens)) return { total: rec.totalTokens, prompt: rec.promptTokens, completion: rec.completionTokens, estimated: false };
  const prompt = Math.round((rec.promptChars || 0) / ESTIMATE_CHARS_PER_TOKEN);
  const completion = Math.round((rec.completionChars || 0) / ESTIMATE_CHARS_PER_TOKEN);
  return { total: prompt + completion, prompt, completion, estimated: true };
}
function summarizeLedger(records) {
  const byKind = {};
  const all = [];
  for (const r of records || []) {
    const k = r.kind || "chat";
    const b = byKind[k] ??= { kind: k, calls: 0, ok: 0, failed: 0, truncated: 0, estimated: 0, prompt: [], completion: [], total: [], latencyMs: [], ttfbMs: [], models: /* @__PURE__ */ new Set() };
    b.calls++;
    if (r.ok) b.ok++;
    else b.failed++;
    if (r.error === "truncated" || r.finishReason === "length") b.truncated++;
    if (r.model) b.models.add(r.model);
    const t = tokensOf(r);
    if (t.estimated) b.estimated++;
    if (t.total > 0) {
      b.total.push(t.total);
      if (Number.isFinite(t.prompt)) b.prompt.push(t.prompt);
      if (Number.isFinite(t.completion)) b.completion.push(t.completion);
    }
    if (Number.isFinite(r.latencyMs)) b.latencyMs.push(r.latencyMs);
    if (Number.isFinite(r.ttfbMs)) b.ttfbMs.push(r.ttfbMs);
    all.push({ r, t });
  }
  const out = {};
  for (const [k, b] of Object.entries(byKind)) out[k] = { kind: k, calls: b.calls, ok: b.ok, failed: b.failed, truncated: b.truncated, estimated: b.estimated, models: [...b.models], prompt: stats(b.prompt), completion: stats(b.completion), total: stats(b.total), latencyMs: stats(b.latencyMs), ttfbMs: stats(b.ttfbMs) };
  const ats = (records || []).map((r) => r.at).filter(Boolean).sort();
  return {
    total: { calls: all.length, ok: all.filter((x) => x.r.ok).length, failed: all.filter((x) => !x.r.ok).length, truncated: all.filter((x) => x.r.error === "truncated").length, estimated: all.filter((x) => x.t.estimated).length, tokens: all.reduce((n, x) => n + (x.t.total || 0), 0), latencyMs: stats(all.map((x) => x.r.latencyMs)) },
    byKind: out,
    models: [...new Set((records || []).map((r) => r.model).filter(Boolean))],
    range: { from: ats[0] || null, to: ats.at(-1) || null }
  };
}
function samplesFor(records, kinds) {
  return (records || []).filter((r) => kinds.includes(r.kind) && r.ok && Number.isFinite(r.totalTokens) && r.totalTokens > 0).map((r) => r.totalTokens);
}
const round100 = (x) => Math.max(100, Math.round(x / 100) * 100);
function derivePrices(records, { quantum = WALLET_QUANTUM, current = import_pricing.PRICES, useP = 95, unitPriceIn, unitPriceOut } = {}) {
  const turn = samplesFor(records, PRICED_KINDS.tutor_turn);
  const turnRef = percentile(turn, useP);
  const rows = [];
  for (const [price, kinds] of Object.entries(PRICED_KINDS)) {
    const xs = samplesFor(records, kinds);
    const recs = (records || []).filter((r) => kinds.includes(r.kind) && r.ok && Number.isFinite(r.totalTokens));
    const pIn = percentile(recs.map((r) => r.promptTokens), useP);
    const pOut = percentile(recs.map((r) => r.completionTokens), useP);
    const ref = percentile(xs, useP);
    const cost = Number.isFinite(unitPriceIn) && Number.isFinite(unitPriceOut) && pIn != null && pOut != null ? (pIn * unitPriceIn + pOut * unitPriceOut) / 1e6 : null;
    let recommended = null;
    let note = "";
    if (!xs.length) note = "\u6CA1\u91CF\u5230\uFF08\u8FD9\u4E00\u7C7B\u4E00\u6B21\u90FD\u6CA1\u8DD1\u5230\uFF0C\u6216\u7F51\u5173\u6CA1\u56DE usage\uFF09";
    else if (price === "tutor_turn") recommended = quantum;
    else if (!turnRef) note = "\u6559\u5B66\u8F6E\u6CA1\u91CF\u5230\uFF0C\u7B97\u4E0D\u51FA\u76F8\u5BF9\u4EF7";
    else recommended = round100(quantum * ref / turnRef);
    rows.push({ price, kinds, calls: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), promptP: pIn, completionP: pOut, costYuan: cost, current: current[price] ?? null, recommended, ratioToTurn: turnRef && ref ? Number((ref / turnRef).toFixed(2)) : null, note });
  }
  return { quantum, useP, turnRef, rows, priced: rows.some((r) => r.recommended != null && r.price !== "tutor_turn") };
}
function anchorSummary(doc, anchors) {
  let steps = 0;
  let stepsAnchored = 0;
  let items = 0;
  let itemsAnchored = 0;
  for (const st of Object.values(doc?.distill || {})) {
    for (const w of st.walkthrough || []) {
      steps++;
      if (w.anchor) stepsAnchored++;
    }
    for (const x of [...st.must_memorize || [], ...st.pitfalls || []]) {
      items++;
      if (typeof x !== "string" && x.anchor) itemsAnchored++;
    }
  }
  const quotes = anchors?.quotes ?? null;
  const hit = anchors?.hit ?? null;
  return { quotes, hit, rate: quotes ? Number((hit / quotes).toFixed(3)) : null, steps, stepsAnchored, items, itemsAnchored, belowTarget: quotes ? hit / quotes < 0.8 : null };
}
const fmt = (v, unit = "") => v == null ? "\u2014" : `${typeof v === "number" ? v.toLocaleString("en-US") : v}${unit}`;
const yuan = (v) => v == null ? "\u2014" : `\xA5${v.toFixed(4)}`;
function renderDogfoodReport(p) {
  const s = p.summary;
  const pr = p.prices;
  const a = p.anchors;
  const m = p.meta || {};
  const L = [];
  L.push(`# ${p.title}`, "");
  L.push(`- \u65E5\u671F\uFF1A${m.date || ""}`, `- \u6A21\u5F0F\uFF1A${m.demo ? "**\u6F14\u793A\u6A21\u5F0F**\uFF08\u6CA1\u914D\u6A21\u578B\uFF1Atoken \u5168\u4E3A 0\uFF0C\u672C\u62A5\u544A\u53EA\u9A8C\u8BC1\u6D41\u7A0B\u4E0E\u62A5\u544A\u683C\u5F0F\uFF0C**\u4E0D\u80FD**\u7528\u6765\u5B9A\u4EF7\uFF09" : `\u771F\u6A21\u578B\uFF08${(s.models || []).join(", ") || m.model || "?"}\uFF09`}`, `- \u8BFE\u7A0B / \u6559\u6750\uFF1A${m.course || ""}\uFF1B${m.materials ?? "?"} \u4EFD\u6559\u6750\u3001${m.sections ?? "?"} \u8282\u3001\u751F\u6210 ${m.stages ?? "?"} \u4E2A\u9636\u6BB5`, `- \u8D70\u8FC7\u7684\u8DEF\uFF1A${m.steps || ""}`, `- \u603B\u8017\u65F6\uFF1A${m.wallSec != null ? `${m.wallSec} \u79D2` : "\u2014"}\uFF1B\u6A21\u578B\u8C03\u7528 ${s.total.calls} \u6B21\uFF08\u6210\u529F ${s.total.ok}\u3001\u5931\u8D25 ${s.total.failed}\u3001\u622A\u65AD ${s.total.truncated}\u3001\u6309\u5B57\u7B26\u4F30\u7B97 ${s.total.estimated}\uFF09\uFF0C\u5408\u8BA1 ${fmt(s.total.tokens)} token`, "");
  L.push("## 1. \u6BCF\u79CD\u8C03\u7528\u7684 token \u4E0E\u5EF6\u8FDF", "", "| kind | \u6B21\u6570 | \u6210\u529F / \u5931\u8D25 / \u622A\u65AD | prompt p50 / p95 | completion p50 / p95 | total p50 / p95 | \u8017\u65F6 p50 / p95\uFF08\u79D2\uFF09 | \u9996\u5B57 p50\uFF08\u79D2\uFF09 | \u4F30\u7B97 |", "|---|---|---|---|---|---|---|---|---|");
  if (!Object.keys(s.byKind).length) L.push("| \u2014 | 0 | \u8D26\u672C\u4E3A\u7A7A | | | | | | |");
  for (const b of Object.values(s.byKind)) L.push(`| ${b.kind} | ${b.calls} | ${b.ok} / ${b.failed} / ${b.truncated} | ${fmt(b.prompt.p50)} / ${fmt(b.prompt.p95)} | ${fmt(b.completion.p50)} / ${fmt(b.completion.p95)} | ${fmt(b.total.p50)} / ${fmt(b.total.p95)} | ${b.latencyMs.p50 == null ? "\u2014" : (b.latencyMs.p50 / 1e3).toFixed(1)} / ${b.latencyMs.p95 == null ? "\u2014" : (b.latencyMs.p95 / 1e3).toFixed(1)} | ${b.ttfbMs.p50 == null ? "\u2014" : (b.ttfbMs.p50 / 1e3).toFixed(1)} | ${b.estimated ? `${b.estimated} \u53D1` : "\u2014"} |`);
  if (!Object.keys(s.byKind).length) L.push("", m.demo ? "> \u6F14\u793A\u6A21\u5F0F\u4E0B\u751F\u6210 / \u6559\u5B66 / \u5224\u5377 / \u84B8\u998F\u5168\u8D70\u672C\u5730\u89C4\u5219\uFF0C**\u4E00\u53D1\u6A21\u578B\u8C03\u7528\u90FD\u6CA1\u6709**\uFF0C\u6240\u4EE5\u8D26\u672C\u4E3A\u7A7A \u2014\u2014 \u8FD9\u662F\u8BBE\u8BA1\u5982\u6B64\uFF0C\u4E0D\u662F\u574F\u4E86\uFF1B\u914D\u4E0A TUTOR_AI_* \u518D\u8DD1\u4E00\u6B21\u624D\u6709\u6570\u3002" : "> \u8D26\u672C\u4E3A\u7A7A\uFF1A\u8FD9\u4E00\u6B21\u4E00\u53D1\u6A21\u578B\u8C03\u7528\u90FD\u6CA1\u8BB0\u5230\u3002\u8981\u4E48\u53C2\u8003\u5B9E\u73B0\u662F\u53E6\u4E00\u4E2A\u5DE5\u4F5C\u533A\u8D77\u7684\uFF08\u8D26\u672C\u843D\u5728\u5B83\u7684 .tutor/usage.jsonl\uFF09\uFF0C\u8981\u4E48\u6240\u6709\u8C03\u7528\u90FD\u6CA1\u8D70\u5230 ai/client.js \u7684\u51FA\u53E3\u3002");
  L.push("", `> kind \u7684\u542B\u4E49\uFF1Aturn / preview = \u6559\u5B66\u8F6E / \u8BD5\u6559\uFF1Bquiz-grade = \u6A21\u578B\u5224\u5377\uFF1Bdistill = \u84B8\u998F\uFF1Bstages / stage / card = \u751F\u6210\u65F6\u7684\u9636\u6BB5\u63D0\u8BAE / \u9010\u9636\u6BB5\u84B8\u998F / \u2460 \u2465\uFF1Bscan = \u626B\u63CF\u76EE\u5F55\u3002\u300C\u4F30\u7B97\u300D= \u7F51\u5173\u6CA1\u56DE usage\u3001\u6309 ${ESTIMATE_CHARS_PER_TOKEN} \u5B57 / token \u4F30\u7684\uFF08\u6D41\u5F0F\u8C03\u7528\u8981\u5F00 TUTOR_AI_STREAM_USAGE=1 \u624D\u4F1A\u56DE usage\uFF09\uFF0C\u4F30\u7B97\u884C\u4E0D\u53C2\u4E0E\u5B9A\u4EF7\u3002`, "");
  L.push(`## 2. \u7531\u5B9E\u6D4B\u63A8\u5355\u4EF7\uFF08\u91CF\u7EB2\uFF1A\u4E00\u6B21 chat = ${pr.quantum} \u94B1\u5305 token\uFF1B\u6309 p${pr.useP} \u5B9A\uFF0C\u5B81\u53EF\u591A\u7B97\u4E0D\u5C11\u7B97\uFF09`, "", "| \u5355\u4EF7 | \u7531\u54EA\u4E9B kind \u6784\u6210 | \u6837\u672C | total p50 / p95 | \u76F8\u5BF9\u6559\u5B66\u8F6E | \u6BCF\u6B21\u6210\u672C\uFF08\u5143\uFF0C\u6309\u7ED9\u7684\u6A21\u578B\u5355\u4EF7\uFF09 | \u73B0\u884C\uFF08\u5EFA\u8BAE\u503C\uFF09 | \u63A8\u8350 | \u5907\u6CE8 |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of pr.rows) L.push(`| \`${r.price}\` | ${r.kinds.join(" / ")} | ${r.calls} | ${fmt(r.p50)} / ${fmt(r.p95)} | ${r.ratioToTurn == null ? "\u2014" : `${r.ratioToTurn}\xD7`} | ${yuan(r.costYuan)} | ${fmt(r.current)} | ${r.recommended == null ? "\u2014" : `**${r.recommended}**`} | ${r.note} |`);
  L.push("", pr.priced ? "> \u600E\u4E48\u7528\uFF1A\u628A\u300C\u63A8\u8350\u300D\u5217\u6284\u8FDB `src/generate/pricing.js` \u7684 `PRICES`\uFF0C\u5E76\u5728\u5E38\u91CF\u65C1\u5199\u300CN \u5E74 N \u6708 N \u65E5\u6309\u672C\u62A5\u544A\u5B9A\uFF0C\u6A21\u578B X\u300D\uFF1Bserver \u7684 `config/tokens.js` \u4E0E App `economy.ts` \u955C\u50CF\u540C\u4E00\u7EC4\u6570\uFF08docs/06 D5\uFF09\u3002" : "> \u8FD9\u6B21\u6CA1\u91CF\u51FA\u53EF\u5B9A\u4EF7\u7684\u6570\uFF08\u89C1\u5907\u6CE8\u5217\uFF09\u3002", "");
  L.push("## 3. \u951A\u70B9\u547D\u4E2D\u7387\uFF08\u8BB2\u89E3\u6B65 / \u5FC5\u80CC / \u6613\u9519\u70B9\u7684\u77ED\u5F15\u80FD\u5426\u5728\u6559\u6750\u91CC\u5BF9\u4E0A\uFF09", "", a ? `- \u751F\u6210\u65F6\u6A21\u578B\u7ED9\u4E86 ${fmt(a.quotes)} \u6761\u77ED\u5F15\uFF0C\u5BF9\u4E0A ${fmt(a.hit)} \u6761\uFF0C\u547D\u4E2D\u7387 ${a.rate == null ? "\u2014" : `${Math.round(a.rate * 100)}%`}${a.belowTarget ? " \u2014\u2014 **\u4F4E\u4E8E\u516B\u6210\uFF0C\u8BE5\u8C03 prompts/stage.md \u4E86**\uFF08docs/06 \xA73.5\uFF09" : a.rate != null ? "\uFF08\u2265 \u516B\u6210\uFF0C\u591F\u7528\uFF09" : ""}
- \u6700\u7EC8\u6587\u6863\uFF1A${a.stepsAnchored}/${a.steps} \u4E2A\u8BB2\u89E3\u6B65\u5E26\u951A\u70B9\uFF0C${a.itemsAnchored}/${a.items} \u6761\u5FC5\u80CC / \u6613\u9519\u70B9\u5E26\u951A\u70B9` : "- \u6CA1\u6709\u6570\u636E", "");
  if (p.timings?.length) {
    L.push("## 4. \u7AEF\u5230\u7AEF\u8017\u65F6\uFF08\u5B66\u751F\u770B\u5230\u7684\uFF09", "", "| \u6B65\u9AA4 | \u79D2 | \u8BF4\u660E |", "|---|---|---|");
    for (const t of p.timings) L.push(`| ${t.step} | ${(t.ms / 1e3).toFixed(1)} | ${t.note || ""} |`);
    L.push("");
  }
  if (p.samples?.length) {
    L.push("## 5. \u8001\u5E08\u8BF4\u4E86\u4EC0\u4E48\uFF08\u524D 200 \u5B57\uFF0C\u7ED9\u4E3B\u4EBA\u4E3B\u89C2\u5224\u65AD\u7528\uFF09", "");
    for (const x of p.samples) L.push(`- **${x.label}**\uFF1A${String(x.text || "").replace(/\s+/g, " ").slice(0, 200)}${String(x.text || "").length > 200 ? "\u2026" : ""}`);
    L.push("");
  }
  L.push("## 6. \u4E3B\u4EBA\u8981\u4EB2\u81EA\u5224\u65AD\u7684\uFF08docs/06 \xA73.3 \u7B2C\u4E00\u6761\uFF0C\u811A\u672C\u66FF\u4E0D\u4E86\uFF09", "");
  for (const c of p.checklist || DEFAULT_CHECKLIST) L.push(`- [ ] ${c}`);
  if (p.notes?.length) {
    L.push("", "## 7. \u8FD9\u6B21\u8DD1\u7684\u5907\u6CE8", "");
    for (const n of p.notes) L.push(`- ${n}`);
  }
  L.push("", "> \u62A5\u544A\u7531 `npm run dogfood` \u751F\u6210\uFF1B\u8D26\u672C\u539F\u59CB\u884C\u5728\u5DE5\u4F5C\u533A `.tutor/usage.jsonl`\uFF08\u4E0D\u542B\u5BC6\u94A5\u3001\u4E0D\u542B\u63D0\u793A\u8BCD\u6B63\u6587\uFF09\u3002\u6570\u503C\u662F\u8FD9\u4E00\u6B21\u8FD9\u53F0\u673A\u5668\u8FD9\u4E2A\u6A21\u578B\u7684\u5B9E\u6D4B\uFF0C\u6362\u6A21\u578B\u8981\u91CD\u8DD1\u3002");
  return L.join("\n") + "\n";
}
const DEFAULT_CHECKLIST = [
  "\u7B2C\u4E00\u9636\u6BB5\u7684\u8BB2\u6CD5\u50CF\u4E0D\u50CF\u8FD9\u95E8\u8BFE\u771F\u6B63\u7684\u8001\u5E08\uFF08\u53E3\u543B\u3001\u5148\u7B97\u8FD8\u662F\u5148\u8BB2\u3001\u4F8B\u5B50\u6765\u6E90\uFF09",
  "\u5708\u9009\u63D0\u95EE\u65F6\u8001\u5E08\u7B2C\u4E00\u53E5\u662F\u53CD\u95EE\u3001\u4E0D\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF1B\u300C\u76F4\u63A5\u8BB2\u300D\u8981\u5148\u8BA9\u5B66\u751F\u8BF4\u4E00\u53E5",
  "\u95EE\u5230\u4F5C\u4E1A / \u8003\u8BD5\u65F6\u8001\u5E08\u8BF4\u7684\u662F\u300C\u8BFE\u7A0B\u653F\u7B56\u300D\u800C\u4E0D\u662F\u300C\u62D2\u7EDD\u300D\uFF0C\u4E14\u771F\u7684\u53EA\u8BB2\u4E86\u539F\u7406",
  "\u81EA\u68C0\u6CA1\u8FC7\u540E\u6362\u8BB2\u6CD5\u518D\u8BB2\uFF0C\u7B2C\u4E8C\u6B21\u8BB2\u6CD5\u786E\u5B9E\u4E0D\u4E00\u6837",
  "\u84B8\u998F\u51FA\u7684\u5361\u70B9 / \u6709\u6548\u8BB2\u6CD5\u770B\u5F97\u61C2\u3001\u8BC1\u636E\u70B9\u56DE\u53BB\u662F\u90A3\u51E0\u8F6E\u539F\u8BDD",
  "\u5BFC\u51FA\u7684 .md \u7C98\u8FDB\u4E00\u4E2A\u7B2C\u4E09\u65B9 AI\uFF08\u8C46\u5305 / ChatGPT / Claude\uFF09\u80FD\u6309 \u2465 \u63A5\u7740\u4E0A\u4E00\u4E2A\u9636\u6BB5",
  "\u62A5\u544A\u7B2C 1 \u8282\u7684 p95 \u5EF6\u8FDF\u80FD\u4E0D\u80FD\u5FCD\uFF08\u6559\u5B66\u8F6E\u9996\u5B57 > 3 \u79D2\u5C31\u8BE5\u6362\u6A21\u578B\u6216\u52A0\u8FDB\u5EA6\u611F\uFF09"
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CHECKLIST,
  ESTIMATE_CHARS_PER_TOKEN,
  PRICED_KINDS,
  WALLET_QUANTUM,
  anchorSummary,
  derivePrices,
  percentile,
  renderDogfoodReport,
  summarizeLedger,
  tokensOf
});
