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
var cleanCheck_exports = {};
__export(cleanCheck_exports, {
  CLEAN_CHECK_THRESHOLD: () => CLEAN_CHECK_THRESHOLD,
  cleanCheck: () => cleanCheck,
  describeCleanCheck: () => describeCleanCheck,
  docSegments: () => docSegments,
  foldForMatch: () => foldForMatch,
  longestCommonRun: () => longestCommonRun
});
module.exports = __toCommonJS(cleanCheck_exports);
var import_normalize = require("./format/normalize.js");
const CLEAN_CHECK_THRESHOLD = 120;
function foldForMatch(text) {
  return (0, import_normalize.normalizeText)(text).replace(/\s+/g, "");
}
function docSegments(doc) {
  const segs = [];
  const add = (where, text) => {
    if (text && text.trim()) segs.push({ where, text });
  };
  add("\u2460 \u662F\u8C01", doc.card.who);
  add("\u2460 \u6559\u5B66\u98CE\u683C", doc.card.teaching_style);
  doc.card.catchphrases.forEach((t, i) => add(`\u2460 \u53E3\u5934\u7985 #${i + 1}`, t));
  doc.card.hard_rules.forEach((r, i) => add(`\u2460 \u786C\u89C4\u5219 #${i + 1}`, r.text));
  doc.card.example_turns.forEach((t, i) => {
    add(`\u2460 \u793A\u4F8B\u5BF9\u8BDD #${i + 1} \u5B66\u751F`, t.student);
    add(`\u2460 \u793A\u4F8B\u5BF9\u8BDD #${i + 1} \u8001\u5E08`, t.teacher);
  });
  add("\u2461 \u5B66\u4E60\u8282\u594F", doc.profile.pace);
  doc.profile.preferences.forEach((t, i) => add(`\u2461 \u504F\u597D #${i + 1}`, t));
  for (const k of ["stuck_points", "effective_methods", "misconceptions"]) (doc.profile[k] || []).forEach((x, i) => add(`\u2461 ${k} #${i + 1}`, x.text));
  doc.map.stages.forEach((s) => {
    add(`\u2462 ${s.stage_id} \u4E3B\u9898`, s.title);
    add(`\u2462 ${s.stage_id} \u6458\u8981`, s.summary);
  });
  const textOf = (x) => typeof x === "string" ? x : x.text;
  const quoteOf = (x, where) => {
    if (x && typeof x === "object" && x.anchor) add(`${where} \u951A\u70B9\u77ED\u5F15`, x.anchor.quote);
  };
  for (const [id, st] of Object.entries(doc.distill)) {
    add(`\u2463 ${id} \xB7 \u8001\u5E08\u7684\u8BB2\u6CD5`, st.method);
    (st.walkthrough || []).forEach((w, i) => {
      add(`\u2463 ${id} \xB7 \u8BB2\u89E3\u6B65 #${i + 1}`, w.say);
      add(`\u2463 ${id} \xB7 \u8BB2\u89E3\u6B65 #${i + 1} \u95EE`, w.ask);
      quoteOf(w, `\u2463 ${id} \xB7 \u8BB2\u89E3\u6B65 #${i + 1}`);
    });
    st.must_memorize.forEach((t, i) => {
      add(`\u2463 ${id} \xB7 \u5FC5\u80CC #${i + 1}`, textOf(t));
      quoteOf(t, `\u2463 ${id} \xB7 \u5FC5\u80CC #${i + 1}`);
    });
    st.self_checks.forEach((q, i) => {
      add(`\u2463 ${id} \xB7 \u81EA\u68C0\u9898 #${i + 1} \u9898`, q.q);
      add(`\u2463 ${id} \xB7 \u81EA\u68C0\u9898 #${i + 1} \u7B54`, q.a);
    });
    st.student_qa.forEach((q, i) => {
      add(`\u2463 ${id} \xB7 \u5B66\u751F\u95EE\u7B54 #${i + 1} \u95EE`, q.q);
      add(`\u2463 ${id} \xB7 \u5B66\u751F\u95EE\u7B54 #${i + 1} \u7B54`, q.a);
    });
    st.pitfalls.forEach((t, i) => {
      add(`\u2463 ${id} \xB7 \u6613\u9519\u70B9 #${i + 1}`, textOf(t));
      quoteOf(t, `\u2463 ${id} \xB7 \u6613\u9519\u70B9 #${i + 1}`);
    });
  }
  doc.log_excerpts.forEach((ex, i) => ex.turns.forEach((t, j) => add(`\u2464 #${i + 1} [${ex.stage_id}] \u7B2C ${j + 1} \u53E5`, t.text)));
  for (const k of ["system_prompt", "how_to_continue", "how_to_update_profile", "boundaries"]) add(`\u2465 ${k}`, doc.guide[k]);
  return segs;
}
function commonRunAtLeast(a, b, k) {
  if (k <= 0) return { aStart: 0, bStart: 0 };
  if (a.length < k || b.length < k) return null;
  const BASE = 1315423911n;
  const MOD = (1n << 61n) - 1n;
  const pow = (() => {
    let p = 1n;
    for (let i = 0; i < k; i++) p = p * BASE % MOD;
    return p;
  })();
  const hashes = /* @__PURE__ */ new Map();
  let h = 0n;
  for (let i = 0; i < b.length; i++) {
    h = (h * BASE + BigInt(b.codePointAt(i) ?? 0)) % MOD;
    if (i >= k) h = (h - BigInt(b.codePointAt(i - k) ?? 0) * pow % MOD + MOD) % MOD;
    if (i >= k - 1) {
      const s = i - k + 1;
      const arr = hashes.get(h);
      if (arr) arr.push(s);
      else hashes.set(h, [s]);
    }
  }
  h = 0n;
  for (let i = 0; i < a.length; i++) {
    h = (h * BASE + BigInt(a.codePointAt(i) ?? 0)) % MOD;
    if (i >= k) h = (h - BigInt(a.codePointAt(i - k) ?? 0) * pow % MOD + MOD) % MOD;
    if (i >= k - 1) {
      const s = i - k + 1;
      const cands = hashes.get(h);
      if (cands) {
        for (const bs of cands) if (a.slice(s, s + k) === b.slice(bs, bs + k)) return { aStart: s, bStart: bs };
      }
    }
  }
  return null;
}
function longestCommonRun(a, b) {
  let lo = 0;
  let hi = Math.min(a.length, b.length);
  let best = { len: 0, aStart: 0, bStart: 0 };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const hit = commonRunAtLeast(a, b, mid);
    if (hit) {
      best = { len: mid, ...hit };
      lo = mid;
    } else hi = mid - 1;
  }
  return best;
}
function cleanCheck(doc, materials, opts = {}) {
  const threshold = opts.threshold ?? CLEAN_CHECK_THRESHOLD;
  const folded = materials.map((m, i) => ({ name: m.name || `\u6559\u6750 #${i + 1}`, text: foldForMatch(m.text || "") })).filter((m) => m.text.length > 0);
  const segments = docSegments(doc);
  const perSegment = [];
  let worst = null;
  for (const seg of segments) {
    const a = foldForMatch(seg.text);
    let segBest = { len: 0, material: "", snippet: "" };
    for (const m of folded) {
      const r = longestCommonRun(a, m.text);
      if (r.len > segBest.len) segBest = { len: r.len, material: m.name, snippet: a.slice(r.aStart, r.aStart + Math.min(r.len, 40)) + (r.len > 40 ? "\u2026" : "") };
    }
    perSegment.push({ where: seg.where, len: segBest.len });
    if (!worst || segBest.len > worst.len) worst = { where: seg.where, ...segBest };
  }
  return { ok: !worst || worst.len < threshold, threshold, worst: worst && worst.len > 0 ? worst : null, perSegment };
}
function describeCleanCheck(result) {
  if (result.ok) {
    const top = result.worst ? `\u6700\u957F\u4E00\u5904 ${result.worst.len} \u5B57\uFF08${result.worst.where}\uFF09` : "\u4E0E\u6559\u6750\u6CA1\u6709\u4EFB\u4F55\u516C\u5171\u7247\u6BB5";
    return `\u6559\u6750\u6CC4\u6F0F\u6838\u67E5\u901A\u8FC7\uFF1A${top}\uFF0C\u9608\u503C ${result.threshold} \u5B57`;
  }
  return `\u6559\u6750\u6CC4\u6F0F\u6838\u67E5\u4E0D\u901A\u8FC7\uFF1A\u300C${result.worst.where}\u300D\u4E0E\u300C${result.worst.material}\u300D\u6709 ${result.worst.len} \u5B57\u8FDE\u7EED\u76F8\u540C\uFF08\u9608\u503C ${result.threshold}\uFF09\uFF0C\u5F00\u5934\u662F\u300C${result.worst.snippet}\u300D\u2014\u2014 \u7528\u81EA\u5DF1\u7684\u8BDD\u91CD\u5199\u8FD9\u4E00\u53E5\uFF0C\u6559\u6750\u539F\u6587\u4E0D\u80FD\u968F\u4EBA\u683C\u5206\u53D1`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLEAN_CHECK_THRESHOLD,
  cleanCheck,
  describeCleanCheck,
  docSegments,
  foldForMatch,
  longestCommonRun
});
