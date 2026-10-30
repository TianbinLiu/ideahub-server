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
var merge_exports = {};
__export(merge_exports, {
  MERGE_LISTS: () => MERGE_LISTS,
  describeMerge: () => describeMerge,
  itemKey: () => itemKey,
  mergeRelease: () => mergeRelease
});
module.exports = __toCommonJS(merge_exports);
var import_constants = require("../format/constants.js");
var import_progress = require("../session/progress.js");
const MERGE_LISTS = ["must_memorize", "self_checks", "pitfalls"];
const clone = (x) => JSON.parse(JSON.stringify(x));
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const listOf = (stage, kind) => stage && Array.isArray(stage[kind]) ? stage[kind] : [];
const capOf = (kind) => import_constants.LIMITS.distill[kind] && import_constants.LIMITS.distill[kind].count || Infinity;
function itemKey(kind, item) {
  if (item == null) return "";
  if (typeof item === "string") return norm(item);
  if (kind === "self_checks" || kind === "student_qa") return norm(item.q);
  return norm(item.text ?? item.say ?? JSON.stringify(item));
}
const authorPart = (st) => JSON.stringify({ m: norm(st && st.method), w: listOf(st, "walkthrough"), ...Object.fromEntries(MERGE_LISTS.map((k) => [k, listOf(st, k).map((x) => itemKey(k, x))])) });
function mergeRelease({ mine, release, base = null, progress = {}, releaseVersion = release && release.version }) {
  if (!mine || !mine.map || !Array.isArray(mine.map.stages) || !mine.distill) throw new Error("\u5408\u5E76\u8981\u5B66\u4E60\u8005\u624B\u91CC\u90A3\u4EFD\u5B8C\u6574\u7684\u6587\u6863\uFF08mine\uFF09");
  if (!release || !release.map || !Array.isArray(release.map.stages) || !release.distill) throw new Error("\u5408\u5E76\u8981\u4F5C\u8005\u7684\u65B0\u7248\u53D1\u5E03\u4EF6\uFF08release\uFF09");
  const oldIds = mine.map.stages.map((s) => s.stage_id);
  const newIds = release.map.stages.map((s) => s.stage_id);
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const prog = clone(progress || {});
  const renamed = [];
  for (const s of release.map.stages) {
    const from = s.renamed_from;
    if (!from || from === s.stage_id || prog[s.stage_id] || !prog[from]) continue;
    prog[s.stage_id] = clone(prog[from]);
    renamed.push({ from, to: s.stage_id, split: newSet.has(from) });
  }
  const movedAway = new Set(renamed.filter((r) => !r.split).map((r) => r.from));
  const removed = oldIds.filter((id) => !newSet.has(id) && !movedAway.has(id));
  const added = newIds.filter((id) => !oldSet.has(id) && !renamed.some((r) => r.to === id && !r.split));
  const archived = {};
  for (const id of removed) archived[id] = { progress: prog[id] ? clone(prog[id]) : null, distill: mine.distill[id] ? clone(mine.distill[id]) : null };
  const next = clone(mine);
  next.map = clone(release.map);
  next.stages = next.map.stages.length;
  const distill = {};
  const changed = [];
  const truncated = [];
  let learnerKept = 0;
  let studentQaKept = 0;
  for (const s of release.map.stages) {
    const id = s.stage_id;
    const ren = renamed.find((r) => r.to === id);
    const myId = oldSet.has(id) ? id : ren ? ren.from : null;
    const rel = release.distill[id] || { method: "", must_memorize: [], self_checks: [], student_qa: [], pitfalls: [] };
    const my = myId ? mine.distill[myId] : null;
    const bs = myId && base && base.distill ? base.distill[myId] : null;
    const out = clone(rel);
    for (const kind of MERGE_LISTS) {
      const relList = listOf(rel, kind);
      const relKeys = new Set(relList.map((x) => itemKey(kind, x)));
      const baseKeys = new Set(listOf(bs, kind).map((x) => itemKey(kind, x)));
      const extras = base ? listOf(my, kind).filter((x) => {
        const k = itemKey(kind, x);
        return k && !relKeys.has(k) && !baseKeys.has(k);
      }) : [];
      const room = Math.max(0, capOf(kind) - relList.length);
      if (extras.length > room) truncated.push({ stage_id: id, kind, dropped: extras.length - room });
      const kept = extras.slice(0, room);
      learnerKept += kept.length;
      out[kind] = [...clone(relList), ...clone(kept)];
    }
    const qaAll = listOf(my, "student_qa");
    const qa = qaAll.slice(0, capOf("student_qa"));
    if (qaAll.length > qa.length) truncated.push({ stage_id: id, kind: "student_qa", dropped: qaAll.length - qa.length });
    out.student_qa = clone(qa);
    studentQaKept += qa.length;
    if (my && authorPart(base ? bs : my) !== authorPart(rel)) changed.push(id);
    distill[id] = out;
  }
  next.distill = distill;
  const nextProgress = (0, import_progress.initProgress)(next, prog);
  const doc = (0, import_progress.progressToDoc)(next, nextProgress);
  return {
    doc,
    progress: nextProgress,
    archived,
    report: { fromVersion: mine.version, releaseVersion, docVersion: release.version, baseKnown: !!base, added, removed, renamed, changed, kept: newIds.filter((id) => oldSet.has(id)).length, learnerKept, studentQaKept, truncated }
  };
}
function describeMerge(report, personaName = "") {
  const parts = [];
  if (report.added.length) parts.push(`\u65B0\u589E ${report.added.length} \u6BB5`);
  if (report.removed.length) parts.push(`\u5F52\u6863 ${report.removed.length} \u6BB5`);
  if (report.renamed.length) parts.push(`\u6539\u540D ${report.renamed.length} \u6BB5`);
  if (report.changed.length) parts.push(`\u66F4\u65B0 ${report.changed.length} \u6BB5\u5185\u5BB9`);
  if (report.learnerKept) parts.push(`\u4FDD\u7559\u4F60\u52A0\u7684 ${report.learnerKept} \u6761`);
  if (report.studentQaKept) parts.push(`\u4FDD\u7559\u4F60\u7684 ${report.studentQaKept} \u6761\u95EE\u7B54`);
  if (!report.baseKnown) parts.push("\u6CA1\u6709\u539F\u7248\u53EF\u6BD4\u5BF9\u3001\u53EA\u4FDD\u4F4F\u4E86\u95EE\u7B54");
  return `\u5408\u5E76${personaName ? ` ${personaName}` : ""} v${report.releaseVersion}${parts.length ? `\uFF1A${parts.join("\u3001")}` : "\uFF1A\u5185\u5BB9\u6CA1\u6709\u53D8\u5316"}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MERGE_LISTS,
  describeMerge,
  itemKey,
  mergeRelease
});
