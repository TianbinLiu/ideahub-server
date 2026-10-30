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
var distill_exports = {};
__export(distill_exports, {
  DEMO_QA_MAX: () => DEMO_QA_MAX,
  DISTILL_EVERY_EXCHANGES: () => DISTILL_EVERY_EXCHANGES,
  DISTILL_IDLE_MS: () => DISTILL_IDLE_MS,
  demoDistillOps: () => demoDistillOps,
  describeOpValue: () => describeOpValue,
  distillDue: () => distillDue,
  distillPrompt: () => distillPrompt,
  distillWindow: () => distillWindow
});
module.exports = __toCommonJS(distill_exports);
var import_prompts = require("../ai/prompts.js");
var import_constants = require("../format/constants.js");
var import_progress = require("./progress.js");
const DISTILL_EVERY_EXCHANGES = 8;
const DISTILL_IDLE_MS = 30 * 6e4;
const DEMO_QA_MAX = 3;
const CONVERSATION_KINDS = /* @__PURE__ */ new Set(["ask", "answer", "teach", "quiz", "quizResult", "select", "meta"]);
const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
};
function distillWindow(run, turns) {
  const upTo = run?.distill?.upTo || 0;
  const win = (turns || []).filter((t) => t.seq > upTo && CONVERSATION_KINDS.has(t.kind));
  const exchanges = win.filter((t) => t.role === "user" && (t.kind === "ask" || t.kind === "quiz")).length;
  const last = win.at(-1);
  return { from: upTo + 1, to: last ? last.seq : upTo, turns: win, exchanges, stageId: [...win].reverse().find((t) => t.stage_id)?.stage_id ?? null };
}
function distillDue(run, turns, reason) {
  const w = distillWindow(run, turns);
  if (!w.turns.some((t) => t.role === "user")) return { due: false, why: "\u6CA1\u6709\u65B0\u7684\u5BF9\u8BDD", window: w };
  if (reason !== "manual" && run?.distill?.failedFrom === w.from) return { due: false, why: "\u8FD9\u4E00\u6BB5\u4E0A\u6B21\u6CA1\u6574\u7406\u6210\uFF0C\u7B49\u4F60\u624B\u52A8\u518D\u8BD5", window: w };
  if (reason === "turns" && w.exchanges < DISTILL_EVERY_EXCHANGES) return { due: false, why: `\u8FD8\u5DEE ${DISTILL_EVERY_EXCHANGES - w.exchanges} \u8F6E`, window: w };
  return { due: true, why: reason, window: w };
}
function distillPrompt({ doc, stage, turns }) {
  const brief = [
    ...doc.profile.stuck_points.filter((x) => !x.resolved_at).map((x) => `- \u5361\u70B9 [${x.stage_id}] ${x.text}`),
    ...doc.profile.effective_methods.map((x) => `- \u6709\u6548\u8BB2\u6CD5 [${x.stage_id}] ${x.text}`)
  ].join("\n") || "\uFF08\u8FD8\u6CA1\u6709\uFF09";
  return (0, import_prompts.loadPrompt)("distill", {
    teacher_name: doc.name,
    stage_id: stage.stage_id,
    stage_title: stage.title,
    profile_brief: brief,
    dialogue: turns.map((t) => `t:${t.seq} ${t.role === "user" || t.role === "student" ? "\u5B66\u751F" : "\u8001\u5E08"}\uFF1A${t.kind === "quizResult" ? `${t.text}\uFF08${(t.results || []).map((r) => `${r.correct ? "\u5BF9" : "\u9519"}\uFF1A${cut(r.q, 40)}`).join("\uFF1B")}\uFF09` : t.text}`).join("\n")
  });
}
function demoDistillOps({ doc, turns }) {
  const ops = [];
  const L = import_constants.LIMITS;
  const push = (op) => {
    if (ops.length < 20 && !ops.some((o) => o.op === op.op && JSON.stringify(o.value) === JSON.stringify(op.value))) ops.push(op);
  };
  const bySeq = new Map(turns.map((t) => [t.seq, t]));
  const asksByStage = /* @__PURE__ */ new Map();
  let qa = 0;
  for (const t of turns) {
    if (t.role === "user" && t.kind === "quizResult" && Array.isArray(t.results)) {
      for (const r of t.results.filter((x) => !x.correct)) {
        if (!t.stage_id) continue;
        push({ op: "profile.stuck_point.add", path: "/profile/stuck_points", value: { stage_id: t.stage_id, text: cut(`\u81EA\u68C0\u6CA1\u7B54\u4E0A\uFF1A\u300C${r.q}\u300D`, L.profile.stuck_points.each) }, evidence: [t.seq], rationale: "\u81EA\u68C0\u7B54\u9519" });
        push({ op: "distill.pitfall.add", path: `/distill/${t.stage_id}/pitfalls`, value: cut(`\u81EA\u68C0\u91CC\u7B54\u9519\u8FC7\u300C${cut(r.q, 60)}\u300D\uFF0C\u8981\u70B9\uFF1A${r.expected}`, L.distill.pitfalls.each), evidence: [t.seq], rationale: "\u81EA\u68C0\u7B54\u9519\u7684\u9898\u503C\u5F97\u5199\u8FDB\u6613\u9519\u70B9" });
      }
      const m = /(?:自检|回访) (\d+)\/(\d+)/.exec(t.text || "");
      if (m && Number(m[2]) > 0 && Number(m[1]) / Number(m[2]) >= import_progress.PASS_RATIO) {
        for (const sp of doc.profile.stuck_points.filter((x) => !x.resolved_at && x.stage_id === t.stage_id && /^自检没答上/.test(x.text))) push({ op: "profile.stuck_point.resolve", path: "/profile/stuck_points", value: { stage_id: sp.stage_id, text: sp.text }, evidence: [t.seq], rationale: "\u8FD9\u4E00\u9636\u6BB5\u81EA\u68C0\u901A\u8FC7\u4E86" });
      }
    }
    if (t.role === "user" && t.kind === "ask" && t.stage_id) {
      asksByStage.set(t.stage_id, [...asksByStage.get(t.stage_id) || [], t.seq]);
      const answer = turns.find((x) => x.role === "assistant" && x.replyTo === t.seq) || turns.find((x) => x.role === "assistant" && x.seq === t.seq + 1);
      if (answer && qa < DEMO_QA_MAX && t.text?.trim()) {
        qa++;
        push({ op: "distill.student_qa.add", path: `/distill/${t.stage_id}/student_qa`, value: { q: cut(t.text, L.distill.student_qa.q), a: cut(answer.text, L.distill.student_qa.a), from_turn: t.seq }, evidence: [t.seq, answer.seq], rationale: "\u503C\u5F97\u7559\u6863\u7684\u4E00\u95EE\u4E00\u7B54" });
      }
      if (t.selection?.anchor) push({ op: "profile.preference.add", path: "/profile/preferences", value: "\u5C31\u7740\u6559\u6750\u539F\u6587\u5708\u9009\u63D0\u95EE", evidence: [t.seq], rationale: "\u5B66\u751F\u5708\u7740\u539F\u6587\u95EE" });
    }
    if (t.role === "assistant" && t.feedback === 1 && t.stage_id && t.text) {
      push({ op: "profile.effective_method.add", path: "/profile/effective_methods", value: { stage_id: t.stage_id, text: cut(`\u8FD9\u6837\u8BB2\u4ED6\u70B9\u4E86\u300C\u6709\u5E2E\u52A9\u300D\uFF1A${firstSentence(t.text)}`, L.profile.effective_methods.each) }, evidence: [t.seq, ...t.replyTo && bySeq.has(t.replyTo) ? [t.replyTo] : []], rationale: "\u5B66\u751F\u7ED9\u8FD9\u4E00\u7B54\u70B9\u4E86\u300C\u6709\u5E2E\u52A9\u300D" });
    }
  }
  for (const [stageId, seqs] of asksByStage) if (seqs.length >= 3) push({ op: "profile.pace.set", path: "/profile/pace", value: cut(`${stageId} \u8FFD\u95EE\u4E86 ${seqs.length} \u6B21\uFF1A\u8BB2\u6162\u4E00\u70B9\uFF0C\u6BCF\u4E00\u6B65\u90FD\u505C\u4E0B\u6765\u95EE\u4E00\u53E5`, L.profile.pace), evidence: seqs.slice(0, 5), rationale: "\u540C\u4E00\u9636\u6BB5\u8FFD\u95EE\u591A" });
  return ops;
}
const firstSentence = (s) => String(s ?? "").split(/(?<=[。！？；.!?])/)[0]?.trim() || String(s ?? "").slice(0, 60);
function describeOpValue(op) {
  const v = op.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v.text ?? (v.q ? `${v.q}${v.a ? ` \u2192 ${v.a}` : ""}` : v.title ?? v.say ?? JSON.stringify(v));
  return String(v ?? "");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEMO_QA_MAX,
  DISTILL_EVERY_EXCHANGES,
  DISTILL_IDLE_MS,
  demoDistillOps,
  describeOpValue,
  distillDue,
  distillPrompt,
  distillWindow
});
