var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var export_exports = {};
__export(export_exports, {
  EXPORT_FORMATS: () => EXPORT_FORMATS,
  EXPORT_MIME: () => EXPORT_MIME,
  EXPORT_RETENTION_DAYS: () => EXPORT_RETENTION_DAYS,
  USAGE_PURPOSES: () => USAGE_PURPOSES,
  applyAudience: () => applyAudience,
  buildExport: () => buildExport,
  exportBaseName: () => exportBaseName,
  exportFileName: () => exportFileName,
  exportRecord: () => exportRecord,
  mergeImport: () => mergeImport,
  parseImport: () => parseImport,
  renderUsage: () => renderUsage,
  toWorkspaceDoc: () => toWorkspaceDoc,
  usageRecords: () => usageRecords,
  zipExport: () => zipExport
});
module.exports = __toCommonJS(export_exports);
var import_jszip = __toESM(require("jszip"), 1);
var import_format = require("../format/index.js");
var import_cleanCheck = require("../cleanCheck.js");
const EXPORT_RETENTION_DAYS = 180;
const EXPORT_FORMATS = ["md", "json", "zip"];
const EXPORT_MIME = { md: "text/markdown; charset=utf-8", json: "application/json; charset=utf-8", zip: "application/zip" };
function applyAudience(src, audience, { keepStuckPoints = false, keepStudentQa = false } = {}) {
  const doc = JSON.parse(JSON.stringify(src));
  doc.audience = audience;
  if (audience === "self") {
    doc.includes_student_profile = "full";
    doc.includes_dialogue_log = doc.log_excerpts.length ? "excerpts" : "none";
    return doc;
  }
  for (const s of doc.map.stages) s.status = "\u672A\u8BB2";
  const p = doc.profile;
  const strip = (x) => ({ stage_id: x.stage_id, text: x.text, ...x.anchor ? { anchor: x.anchor } : {} });
  p.effective_methods = p.effective_methods.map(strip);
  p.stuck_points = keepStuckPoints ? p.stuck_points.filter((x) => !x.resolved_at).map(strip) : [];
  p.misconceptions = [];
  delete p.mastery;
  delete p.updated_at;
  const seedEmpty = !p.pace && !p.preferences.length && !p.effective_methods.length && !p.stuck_points.length;
  doc.includes_student_profile = seedEmpty ? "none" : "seed";
  if (!keepStudentQa) for (const st of Object.values(doc.distill)) st.student_qa = [];
  doc.includes_dialogue_log = doc.log_excerpts.length ? "excerpts" : "none";
  return doc;
}
const exportBaseName = (doc) => `tutor-persona-${doc.id}-v${doc.version}`;
const exportFileName = (doc, format) => `${exportBaseName(doc)}.${format}`;
function buildExport(srcDoc, { audience = "market", materials = null, keepStuckPoints = false, keepStudentQa = false, threshold, skipCleanCheck = false, now = /* @__PURE__ */ new Date() } = {}) {
  if (!import_format.constants.AUDIENCES.includes(audience)) return { ok: false, code: "INVALID", message: `audience \u53EA\u80FD\u662F ${import_format.constants.AUDIENCES.join(" / ")}`, warnings: [] };
  const doc = applyAudience(srcDoc, audience, { keepStuckPoints, keepStudentQa });
  doc.exported_at = now.toISOString();
  doc.AIGC = { ...doc.AIGC, ProduceID: (0, import_format.expectedProduceId)(doc) };
  if (!doc.provenance) doc.provenance = { generated_at: doc.exported_at, method: "\u6559\u6750\u4E0E\u5BF9\u8BDD\u7ECF AI \u63D0\u70BC\uFF0C\u4EBA\u5DE5\u5BA1\u5B9A" };
  const v = (0, import_format.validateTutorDoc)(doc, { requireLabels: false });
  const warnings = [...v.warnings];
  if (!v.ok) return { ok: false, code: "INVALID", message: `\u4E0D\u5BFC\u51FA\uFF1A${v.errors.join("\uFF1B")}`, errors: v.errors, warnings };
  let clean = null;
  let cleanSkipped = true;
  if (!skipCleanCheck && materials && materials.length) {
    clean = (0, import_cleanCheck.cleanCheck)(doc, materials, threshold ? { threshold } : {});
    cleanSkipped = false;
    if (!clean.ok) return { ok: false, code: "CLEAN_CHECK", message: (0, import_cleanCheck.describeCleanCheck)(clean), clean, warnings };
  } else if (skipCleanCheck) warnings.push("\u6309\u8981\u6C42\u8DF3\u8FC7\u6559\u6750\u6CC4\u6F0F\u6838\u67E5\uFF08\u53D1\u5E03\u524D\u5FC5\u987B\u8865\u8DD1\uFF09");
  else warnings.push("\u8FD9\u95E8\u8BFE\u6CA1\u6709\u6559\u6750\u6587\u672C\uFF0C\u6CC4\u6F0F\u6838\u67E5\u6CA1\u6CD5\u8DD1 \u2014\u2014 \u5148\u767B\u8BB0\u6559\u6750\u518D\u5BFC\u51FA\u624D\u7B97\u67E5\u8FC7");
  const { text, checksum } = (0, import_format.renderTutorDoc)(doc);
  doc.checksum = checksum;
  const jsonText = JSON.stringify((0, import_format.toJsonMirror)(doc), null, 2) + "\n";
  const manifest = {
    format: doc.format,
    id: doc.id,
    version: doc.version,
    name: doc.name,
    audience: doc.audience,
    checksum,
    AIGC: doc.AIGC,
    exported_at: doc.exported_at,
    files: [
      { name: "persona.md", sha256: (0, import_format.sha256Hex)(text), bytes: Buffer.byteLength(text) },
      { name: "persona.json", sha256: (0, import_format.sha256Hex)(jsonText), bytes: Buffer.byteLength(jsonText) }
    ]
  };
  if (Buffer.byteLength(text) > import_format.constants.LIMITS.file_bytes.max) warnings.push(`\u5BFC\u51FA\u4EF6 ${Buffer.byteLength(text)} \u5B57\u8282\uFF0C\u8D85\u8FC7 ${import_format.constants.LIMITS.file_bytes.max} \u5B57\u8282\u4E0A\u9650\uFF08\u5EFA\u8BAE\u503C\uFF09`);
  return { ok: true, doc, text, jsonText, checksum, manifest, clean, cleanSkipped, warnings };
}
async function zipExport({ text, jsonText, manifest }) {
  const zip = new import_jszip.default();
  zip.file("persona.md", text);
  zip.file("persona.json", jsonText);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function exportRecord({ doc, checksum, format, bytes, sha256, by = "author", extra = {} }) {
  return { id: (0, import_format.sha256Hex)(`${doc.exported_at}:${doc.id}:v${doc.version}:${format}`).slice(0, 16), at: doc.exported_at, by, audience: doc.audience, version: doc.version, format, bytes, sha256, checksum, ProduceID: doc.AIGC.ProduceID, ContentProducer: doc.AIGC.ContentProducer, retainDays: EXPORT_RETENTION_DAYS, ...extra };
}
function parseImport({ text, json } = {}) {
  try {
    if (json !== void 0 && json !== null && json !== "") {
      const doc2 = (0, import_format.fromJsonMirror)(json);
      const { checksum } = (0, import_format.renderTutorDoc)(doc2);
      if (doc2.checksum && doc2.checksum !== checksum) return { ok: false, message: `persona.json \u7684 checksum \u4E0E\u6B63\u6587\u5BF9\u4E0D\u4E0A\uFF08\u6587\u4EF6\u5199 ${doc2.checksum}\uFF0C\u7B97\u51FA ${checksum}\uFF09\u2014\u2014 \u6B63\u6587\u88AB\u6539\u8FC7`, errors: ["checksum"] };
      const v2 = (0, import_format.validateTutorDoc)({ ...doc2, checksum }, { requireLabels: false });
      if (!v2.ok) return { ok: false, message: `persona.json \u4E0D\u5408\u89C4\u8303\uFF1A${v2.errors.join("\uFF1B")}`, errors: v2.errors };
      return { ok: true, doc: { ...doc2, checksum }, source: "json", checksum, warnings: v2.warnings };
    }
    if (typeof text !== "string" || !text.trim()) return { ok: false, message: "\u6CA1\u6709\u5185\u5BB9\uFF1A\u8981\u4E48 text\uFF08.md \u5168\u6587\uFF09\uFF0C\u8981\u4E48 json\uFF08persona.json\uFF09", errors: ["empty"] };
    if (Buffer.byteLength(text) > import_format.constants.LIMITS.file_bytes.max * 2) return { ok: false, message: `\u6587\u4EF6 ${Buffer.byteLength(text)} \u5B57\u8282\uFF0C\u8D85\u8FC7\u4E0A\u9650`, errors: ["too_large"] };
    const { doc, meta } = (0, import_format.parseTutorDoc)(text);
    const v = (0, import_format.validateTutorDoc)(doc, meta);
    if (!v.ok) return { ok: false, message: `\u8FD9\u4EFD .md \u4E0D\u5408\u89C4\u8303\uFF1A${v.errors.join("\uFF1B")}`, errors: v.errors };
    return { ok: true, doc, source: "md", checksum: meta.computedChecksum, warnings: [...meta.warnings || [], ...v.warnings] };
  } catch (e) {
    return { ok: false, message: e.message, errors: e.details || [e.message] };
  }
}
function toWorkspaceDoc(doc) {
  const next = JSON.parse(JSON.stringify(doc));
  next.audience = "self";
  next.includes_student_profile = "full";
  delete next.exported_at;
  delete next.checksum;
  return next;
}
function mergeImport(workspace, incoming) {
  const next = toWorkspaceDoc(incoming);
  if (!workspace) return next;
  if (incoming.audience === "self") return next;
  next.profile = JSON.parse(JSON.stringify(workspace.profile));
  for (const [id, st] of Object.entries(next.distill)) {
    const ws = workspace.distill?.[id];
    if (ws && (!st.student_qa || !st.student_qa.length) && ws.student_qa?.length) st.student_qa = JSON.parse(JSON.stringify(ws.student_qa));
  }
  next.includes_dialogue_log = workspace.includes_dialogue_log || next.includes_dialogue_log;
  return next;
}
const USAGE_PURPOSES = {
  ask: "\u5411 AI \u8001\u5E08\u63D0\u95EE / \u7B54\u7591",
  quiz: "\u5C31\u5708\u9009\u7684\u6BB5\u843D\u8BF7 AI \u8001\u5E08\u51FA\u9898",
  quizResult: "\u9636\u6BB5\u81EA\u68C0\uFF08AI \u8001\u5E08\u5224\u5206\uFF09",
  review: "\u5230\u671F\u56DE\u8BBF\u81EA\u68C0\uFF08AI \u8001\u5E08\u5224\u5206\uFF09",
  select: "\u5708\u9009\u6559\u6750\u6807\u8BB0\u300C\u6CA1\u61C2\u300D\uFF08\u4E0D\u8FC7\u6A21\u578B\uFF09",
  meta: "\u5708\u9009\u6559\u6750\u52A0\u5165\u5FC5\u80CC\uFF08\u4E0D\u8FC7\u6A21\u578B\uFF0C\u7B49\u4F5C\u8005\u70B9\u5934\uFF09",
  teach: "\u542C AI \u8001\u5E08\u8BB2\u89E3\u672C\u9636\u6BB5"
};
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function usageRecords({ doc, course, run, turns, model, from, to, now = /* @__PURE__ */ new Date() }) {
  const lo = from ? Date.parse(from) : -Infinity;
  const hi = to ? Date.parse(to) : Infinity;
  const stageTitle = (id) => doc.map.stages.find((s) => s.stage_id === id)?.title || "";
  const rows = [];
  for (const t of turns || []) {
    const at = Date.parse(t.at || "");
    if (!(at >= lo && at <= hi)) continue;
    if (t.role === "assistant" && t.kind === "teach") {
      rows.push(row(t, "teach"));
      continue;
    }
    if (t.role !== "user") continue;
    const kind = t.kind === "quizResult" ? t.review ? "review" : "quizResult" : t.kind;
    if (!USAGE_PURPOSES[kind]) continue;
    rows.push(row(t, kind));
  }
  function row(t, kind) {
    const detail = kind === "quizResult" || kind === "review" ? t.text : kind === "select" || kind === "meta" ? `\u300C${t.selection?.anchor?.quote ?? ""}\u300D` : kind === "teach" ? "" : String(t.text || "").replace(/\s+/g, " ").slice(0, 120);
    return { at: t.at, seq: t.seq, stage_id: t.stage_id, stage_title: stageTitle(t.stage_id), kind, purpose: USAGE_PURPOSES[kind], detail, policy_blocked: !!t.flags?.policyBlocked, homework_detected: !!t.flags?.homeworkDetected, demo: !!t.demo };
  }
  const n = (k) => rows.filter((r) => r.kind === k).length;
  return {
    tool: `\u542F\u68A6\u8001\u5E08\uFF08AI \u8001\u5E08\u4EBA\u683C\u300C${doc.name}\u300D\xB7 ${doc.subject}\uFF09`,
    version: `\u4EBA\u683C v${doc.version} \xB7 \u683C\u5F0F ${doc.format}`,
    model: model || (rows.some((r) => r.demo) || run?.demo ? "\u6F14\u793A\u6A21\u5F0F\uFF08\u786E\u5B9A\u6027\u56DE\u590D\uFF0C\u672A\u8C03\u7528\u6A21\u578B\uFF09" : "\u5DF2\u914D\u7F6E\u7684\u6A21\u578B"),
    course: { title: course?.title || doc.course?.title || "", code: course?.code || doc.course?.code || "", term: course?.term || doc.course?.term || "", policy: course?.policy || doc.policy || {} },
    range: { from: from || null, to: to || null },
    generated_at: now.toISOString(),
    rows,
    summary: { rows: rows.length, asks: n("ask") + n("quiz"), teaches: n("teach"), quizzes: n("quizResult") + n("review"), marks: n("select") + n("meta"), policy_blocked: rows.filter((r) => r.policy_blocked).length, stages: [...new Set(rows.map((r) => r.stage_id).filter(Boolean))], first_at: rows[0]?.at || null, last_at: rows.at(-1)?.at || null }
  };
}
function renderUsage(rec, format = "md") {
  if (format === "json") return JSON.stringify(rec, null, 2) + "\n";
  const header = ["\u65F6\u95F4", "\u5DE5\u5177\u540D\u79F0", "\u7248\u672C\u53F7", "\u7528\u9014", "\u9636\u6BB5", "\u5185\u5BB9\u6458\u8981", "\u653F\u7B56\u62E6\u622A"];
  if (format === "csv") {
    const lines = [header.map(csvCell).join(",")];
    for (const r of rec.rows) lines.push([r.at, rec.tool, `${rec.version} \xB7 ${rec.model}`, r.purpose, r.stage_id ? `${r.stage_id} ${r.stage_title}` : "", r.detail, r.policy_blocked ? "\u662F\uFF08\u53EA\u8BB2\u539F\u7406\uFF09" : ""].map(csvCell).join(","));
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }
  const md = [];
  md.push(`# AI \u4F7F\u7528\u8BB0\u5F55`, "", `- **\u5DE5\u5177\u540D\u79F0**\uFF1A${rec.tool}`, `- **\u7248\u672C\u53F7**\uFF1A${rec.version}\uFF1B\u6A21\u578B\uFF1A${rec.model}`, `- **\u8BFE\u7A0B**\uFF1A${[rec.course.title, rec.course.code, rec.course.term].filter(Boolean).join(" \xB7 ") || "\u2014"}\uFF1BAI \u4F7F\u7528\u653F\u7B56\uFF1A${rec.course.policy?.ai || "\u2014"} / ${rec.course.policy?.homework_mode || "\u2014"}`, `- **\u4F7F\u7528\u65F6\u95F4**\uFF1A${rec.summary.first_at || "\u2014"} \uFF5E ${rec.summary.last_at || "\u2014"}\uFF08${rec.summary.rows} \u6B21\uFF09`, `- **\u5177\u4F53\u7528\u9014**\uFF1A\u63D0\u95EE / \u51FA\u9898 ${rec.summary.asks} \u6B21\u3001\u542C\u8BB2 ${rec.summary.teaches} \u6B21\u3001\u81EA\u68C0 / \u56DE\u8BBF ${rec.summary.quizzes} \u6B21\u3001\u5708\u9009\u6807\u8BB0 ${rec.summary.marks} \u6B21${rec.summary.policy_blocked ? `\uFF1B\u5176\u4E2D ${rec.summary.policy_blocked} \u6B21\u89E6\u53CA\u4F5C\u4E1A / \u8003\u8BD5\uFF0C\u6309\u8BFE\u7A0B\u653F\u7B56\u53EA\u8BB2\u4E86\u539F\u7406` : ""}`, `- **\u751F\u6210\u65F6\u95F4**\uFF1A${rec.generated_at}`, "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
  for (const r of rec.rows) md.push(`| ${[r.at, rec.tool, rec.version, r.purpose, r.stage_id ? `${r.stage_id} ${r.stage_title}` : "", r.detail.replace(/\|/g, "\\|"), r.policy_blocked ? "\u662F" : ""].join(" | ")} |`);
  md.push("", "> \u672C\u8BB0\u5F55\u7531\u542F\u68A6\u8001\u5E08\u6309\u5B66\u4E60\u4F1A\u8BDD\u81EA\u52A8\u751F\u6210\uFF0C\u4F9B\u5B66\u4E60\u8005\u5411\u5B66\u6821\u63D0\u4EA4 AI \u4F7F\u7528\u58F0\u660E\u65F6\u5F15\u7528\uFF1B\u6BCF\u4E00\u884C\u5BF9\u5E94\u4E00\u6B21\u4E0E AI \u8001\u5E08\u7684\u4EA4\u4E92\u3002");
  return md.join("\n") + "\n";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EXPORT_FORMATS,
  EXPORT_MIME,
  EXPORT_RETENTION_DAYS,
  USAGE_PURPOSES,
  applyAudience,
  buildExport,
  exportBaseName,
  exportFileName,
  exportRecord,
  mergeImport,
  parseImport,
  renderUsage,
  toWorkspaceDoc,
  usageRecords,
  zipExport
});
