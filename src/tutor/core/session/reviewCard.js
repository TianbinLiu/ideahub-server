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
var reviewCard_exports = {};
__export(reviewCard_exports, {
  REVIEW_ANCHORED_MAX: () => REVIEW_ANCHORED_MAX,
  REVIEW_QUESTIONS_MAX: () => REVIEW_QUESTIONS_MAX,
  reviewCard: () => reviewCard,
  reviewQuestions: () => reviewQuestions
});
module.exports = __toCommonJS(reviewCard_exports);
function reviewCard(doc, run, turns) {
  const selections = (turns || []).filter((t) => t.role === "user" && t.selection?.anchor).map((t) => ({
    seq: t.seq,
    kind: t.kind,
    stage_id: t.stage_id,
    at: t.at,
    anchor: t.selection.anchor,
    text: t.kind === "select" ? "" : t.text || ""
  }));
  const stuck = (doc.profile?.stuck_points || []).filter((x) => !x.resolved_at).map(({ stage_id, text, anchor }) => ({ stage_id, text, ...anchor ? { anchor } : {} }));
  const mustMemorize = doc.map.stages.map((s) => ({
    stage_id: s.stage_id,
    title: s.title,
    status: run.progress?.[s.stage_id]?.status ?? "pending",
    items: (doc.distill[s.stage_id]?.must_memorize || []).map((x) => typeof x === "string" ? { text: x } : { text: x.text, ...x.anchor ? { anchor: x.anchor } : {} })
  }));
  const reviews = Object.entries(run.progress || {}).filter(([, p]) => p.nextReviewAt).map(([stage_id, p]) => ({ stage_id, nextReviewAt: p.nextReviewAt })).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
  return { done: run.status === "done", doneAt: run.doneAt, selections, stuck, mustMemorize, nextReview: reviews[0] ?? null };
}
const REVIEW_QUESTIONS_MAX = 3;
const REVIEW_ANCHORED_MAX = 2;
const textOf = (x) => typeof x === "string" ? x : x?.text ?? "";
const fold = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, "");
function reviewQuestions(doc, run, turns, stageId) {
  const card = reviewCard(doc, run, turns);
  const st = doc.distill[stageId] || {};
  const stage = doc.map.stages.find((s) => s.stage_id === stageId);
  const seen = /* @__PURE__ */ new Set();
  const anchored = [];
  const pool = [
    ...card.selections.filter((x) => x.stage_id === stageId).map((x) => ({ anchor: x.anchor, from: "selection" })),
    ...card.stuck.filter((x) => x.stage_id === stageId && x.anchor).map((x) => ({ anchor: x.anchor, from: "stuck" }))
  ];
  for (const { anchor, from } of pool) {
    const key = fold(anchor.quote);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ref = referenceFor(doc, anchor);
    anchored.push({ q: `\u4F60\u5F53\u65F6${from === "stuck" ? "\u6807\u8FC7\u6CA1\u61C2" : "\u5708\u8FC7"}\u7B2C ${anchor.page} \u9875\u8FD9\u4E00\u5904\uFF1A\u300C${anchor.quote}\u300D\u2014\u2014 \u73B0\u5728\u7528\u81EA\u5DF1\u7684\u8BDD\u8BF4\u8BF4\u5B83\u5728\u8BB2\u4EC0\u4E48\uFF1F`, a: ref, kind: "concept", from, anchor });
    if (anchored.length >= REVIEW_ANCHORED_MAX) break;
  }
  const checks = (st.self_checks || []).slice(0, Math.max(0, REVIEW_QUESTIONS_MAX - anchored.length)).map((c) => ({ q: c.q, a: c.a, kind: c.kind || "concept", from: "self_check", ...c.anchor ? { anchor: c.anchor } : {} }));
  const out = [...anchored, ...checks];
  if (!out.length) {
    const memo = textOf((st.must_memorize || [])[0]);
    if (memo) out.push({ q: `\u300C${stage?.title ?? stageId}\u300D\u91CC\u6700\u8BE5\u8BB0\u4F4F\u7684\u4E00\u70B9\u662F\u4EC0\u4E48\uFF1F`, a: memo, kind: "concept", from: "must_memorize" });
  }
  return out;
}
function referenceFor(doc, anchor) {
  const key = fold(anchor.quote);
  const same = (a) => a && a.material === anchor.material && a.page === anchor.page && fold(a.quote) === key;
  for (const st of Object.values(doc.distill || {})) {
    for (const x of [...st.must_memorize || [], ...st.pitfalls || []]) {
      if (typeof x !== "string" && same(x.anchor)) return x.text;
      if (key && fold(textOf(x)).includes(key)) return textOf(x);
    }
    for (const w of st.walkthrough || []) if (same(w.anchor)) return w.say;
  }
  return anchor.quote;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  REVIEW_ANCHORED_MAX,
  REVIEW_QUESTIONS_MAX,
  reviewCard,
  reviewQuestions
});
