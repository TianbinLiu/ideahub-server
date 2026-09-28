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
var progress_exports = {};
__export(progress_exports, {
  PASS_RATIO: () => PASS_RATIO,
  REVIEW_INTERVALS_DAYS: () => REVIEW_INTERVALS_DAYS,
  RUN_STAGE_STATUS: () => RUN_STAGE_STATUS,
  advance: () => advance,
  allPassed: () => allPassed,
  currentStageId: () => currentStageId,
  dueReviews: () => dueReviews,
  initProgress: () => initProgress,
  progressToDoc: () => progressToDoc,
  runStatusOf: () => runStatusOf,
  stageOrder: () => stageOrder,
  stepCount: () => stepCount
});
module.exports = __toCommonJS(progress_exports);
var import_constants = require("../format/constants.js");
const RUN_STAGE_STATUS = ["pending", "taught", "passed"];
const PASS_RATIO = 2 / 3;
const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14];
const [FILE_PENDING, FILE_TAUGHT, FILE_PASSED] = import_constants.STAGE_STATUS;
const FILE_TO_RUN = { [FILE_PENDING]: "pending", [FILE_TAUGHT]: "taught", [FILE_PASSED]: "passed" };
const RUN_TO_FILE = { pending: FILE_PENDING, taught: FILE_TAUGHT, passed: FILE_PASSED };
function initProgress(doc, existing = {}) {
  const out = {};
  for (const st of doc.map.stages) {
    const prev = existing[st.stage_id];
    out[st.stage_id] = prev ? { ...prev, status: RUN_STAGE_STATUS.includes(prev.status) ? prev.status : "pending", stepIdx: Number.isInteger(prev.stepIdx) ? prev.stepIdx : 0 } : { status: FILE_TO_RUN[st.status] ?? "pending", stepIdx: 0 };
  }
  return out;
}
const stageOrder = (doc) => doc.map.stages.map((s) => s.stage_id);
const stepCount = (doc, stageId) => doc.distill[stageId]?.walkthrough?.length ?? 0;
const allPassed = (doc, progress) => stageOrder(doc).every((id) => progress[id]?.status === "passed");
const currentStageId = (doc, progress) => stageOrder(doc).find((id) => progress[id]?.status !== "passed") ?? null;
const runStatusOf = (doc, progress) => allPassed(doc, progress) ? "done" : "active";
function advance(doc, run, event, now = /* @__PURE__ */ new Date()) {
  const progress = JSON.parse(JSON.stringify(run.progress || {}));
  const st = progress[event?.stage];
  if (!st) return { error: `\u9636\u6BB5 ${event?.stage ?? "?"} \u4E0D\u5728\u8BFE\u7A0B\u5730\u56FE\u91CC` };
  const changed = [];
  let justPassed = false;
  const pass = (how) => {
    st.status = "passed";
    st.passedAt = now.toISOString();
    st.reviewRound = 0;
    st.nextReviewAt = addDays(now, REVIEW_INTERVALS_DAYS[0]).toISOString();
    justPassed = true;
    changed.push(`${event.stage}\uFF1A\u5B66\u751F\u5DF2\u901A\u8FC7\uFF08${how}\uFF09`);
  };
  switch (event.type) {
    case "step": {
      const n = stepCount(doc, event.stage);
      const idx = Math.max(0, Math.min(Number.isInteger(event.stepIdx) ? event.stepIdx : 0, Math.max(n - 1, 0)));
      st.stepIdx = idx;
      if (n > 0 && idx >= n - 1 && st.status === "pending") {
        st.status = "taught";
        changed.push(`${event.stage}\uFF1A\u8BB2\u89E3\u6B65\u8D70\u5B8C \u2192 \u5DF2\u8BB2`);
      }
      break;
    }
    case "taught":
      if (st.status === "pending") {
        st.status = "taught";
        changed.push(`${event.stage}\uFF1A\u8001\u5E08\u8BB2\u5B8C \u2192 \u5DF2\u8BB2`);
      }
      break;
    case "quiz": {
      if (st.status === "pending") return { error: "\u8FD9\u4E00\u9636\u6BB5\u8FD8\u6CA1\u8BB2\u5B8C\uFF1A\u5148\u628A\u8BB2\u89E3\u6B65\u8D70\u5B8C\uFF08\u6216\u8BA9\u8001\u5E08\u8BB2\u4E00\u904D\uFF09\u518D\u81EA\u68C0" };
      const asked = Number(event.asked) || 0;
      const correct = Math.max(0, Math.min(Number(event.correct) || 0, asked));
      if (asked <= 0) return { error: "\u81EA\u68C0\u81F3\u5C11\u8981\u6709\u4E00\u9053\u9898" };
      st.quiz = { correct, asked, at: now.toISOString() };
      if (st.status === "passed") {
        changed.push(`${event.stage}\uFF1A\u56DE\u8BBF\u81EA\u68C0 ${correct}/${asked}`);
        if (correct / asked < PASS_RATIO) {
          st.status = "taught";
          st.stepIdx = 0;
          delete st.nextReviewAt;
          changed.push(`${event.stage}\uFF1A\u56DE\u8BBF\u672A\u8FC7 \u2192 \u9000\u56DE\u5DF2\u8BB2`);
          break;
        }
        st.reviewRound = (st.reviewRound || 0) + 1;
        st.lastReviewAt = now.toISOString();
        const days = REVIEW_INTERVALS_DAYS[Math.min(st.reviewRound, REVIEW_INTERVALS_DAYS.length - 1)];
        st.nextReviewAt = addDays(now, days).toISOString();
        changed.push(`${event.stage}\uFF1A\u56DE\u8BBF\u901A\u8FC7\uFF0C\u4E0B\u6B21 ${days} \u5929\u540E`);
        break;
      }
      if (correct / asked >= PASS_RATIO) pass(`\u81EA\u68C0 ${correct}/${asked}`);
      else changed.push(`${event.stage}\uFF1A\u81EA\u68C0 ${correct}/${asked} \u672A\u8FC7\uFF0C\u4ECD\u662F\u5DF2\u8BB2 \u2014\u2014 \u6362\u4E2A\u8BB2\u6CD5\u518D\u6765`);
      break;
    }
    case "skip":
      if (!event.byAuthor) return { error: "\u53EA\u6709\u4F5C\u8005\u80FD\u8DF3\u8FC7\u81EA\u68C0\uFF08docs/05 \xA75.3\uFF09" };
      if (st.status === "passed") return { error: `${event.stage} \u5DF2\u7ECF\u901A\u8FC7\u4E86` };
      pass("\u4F5C\u8005\u8DF3\u8FC7");
      break;
    default:
      return { error: `\u4E0D\u8BA4\u8BC6\u7684\u4E8B\u4EF6 ${event.type}` };
  }
  if (justPassed) {
    const order = stageOrder(doc);
    const next = order[order.indexOf(event.stage) + 1];
    if (next && progress[next]) progress[next].stepIdx = 0;
  }
  const status = runStatusOf(doc, progress);
  if (status === "done" && run.status !== "done") changed.push("\u5168\u90E8\u9636\u6BB5\u901A\u8FC7\uFF1A\u8FD9\u4E00\u5957\u5B66\u4E60\u8FC7\u7A0B\u8D70\u5B8C\u4E86");
  return { progress, status, changed };
}
function dueReviews(doc, progress, now = /* @__PURE__ */ new Date()) {
  const t = now.getTime();
  return doc.map.stages.map((s) => ({ s, p: progress?.[s.stage_id] })).filter(({ p }) => p?.status === "passed" && p.nextReviewAt && Date.parse(p.nextReviewAt) <= t).map(({ s, p }) => ({ stage_id: s.stage_id, title: s.title, nextReviewAt: p.nextReviewAt, reviewRound: p.reviewRound || 0, overdueDays: Math.floor((t - Date.parse(p.nextReviewAt)) / 864e5) })).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt));
}
function progressToDoc(doc, progress) {
  const next = JSON.parse(JSON.stringify(doc));
  for (const st of next.map.stages) {
    const p = progress[st.stage_id];
    if (p) st.status = RUN_TO_FILE[p.status] ?? FILE_PENDING;
  }
  return next;
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 864e5);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PASS_RATIO,
  REVIEW_INTERVALS_DAYS,
  RUN_STAGE_STATUS,
  advance,
  allPassed,
  currentStageId,
  dueReviews,
  initProgress,
  progressToDoc,
  runStatusOf,
  stageOrder,
  stepCount
});
