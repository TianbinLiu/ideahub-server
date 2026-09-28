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
var publish_exports = {};
__export(publish_exports, {
  DEFAULT_COVER: () => DEFAULT_COVER,
  GATES: () => GATES,
  TAGS_MAX: () => TAGS_MAX,
  TAG_MAX_LEN: () => TAG_MAX_LEN,
  checkGates: () => checkGates,
  previewOf: () => previewOf
});
module.exports = __toCommonJS(publish_exports);
var import_export = require("../export/index.js");
var import_demo = require("../generate/demo.js");
const TAGS_MAX = 6;
const TAG_MAX_LEN = 20;
const DEFAULT_COVER = "\u{1F393}";
const GATES = ["license", "cleanCheck", "adult", "aigc", "name"];
function checkGates({ doc, materials, materialTexts, adultDeclared, body = {}, now = /* @__PURE__ */ new Date() }) {
  if (!doc) return { ok: false, gate: "persona", message: "\u8FD9\u95E8\u8BFE\u8FD8\u6CA1\u6709\u8001\u5E08\uFF08\u5148\u751F\u6210\uFF09" };
  const name = String(body.name ?? doc.name ?? "").trim().slice(0, 120);
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim().toLowerCase().slice(0, TAG_MAX_LEN)).filter(Boolean))];
  if (tags.length > TAGS_MAX) return { ok: false, gate: "tags", message: `\u6807\u7B7E\u6700\u591A ${TAGS_MAX} \u4E2A\uFF0C\u7ED9\u4E86 ${tags.length} \u4E2A` };
  const mats = Array.isArray(materials) ? materials : [];
  if (!mats.length) return { ok: false, gate: "license", message: "\u8FD9\u95E8\u8BFE\u8FD8\u6CA1\u6709\u6559\u6750\uFF0C\u6CA1\u6709\u53EF\u53D1\u5E03\u7684\u8001\u5E08" };
  const unsure = mats.filter((m) => m.license?.source === "unsure");
  if (unsure.length) return { ok: false, gate: "license", message: `\u6709 ${unsure.length} \u4EFD\u6559\u6750\u7684\u6388\u6743\u6765\u6E90\u8FD8\u662F\u300C\u4E0D\u786E\u5B9A\u300D\uFF1A${unsure.map((m) => m.name).join("\u3001")}\u3002\u5148\u5728\u8BFE\u7A0B\u9875\u628A\u6BCF\u4E00\u4EFD\u6539\u6210\u786E\u5B9A\u7684\u6765\u6E90`, details: { unsure: unsure.map((m) => m.sha) } };
  if (doc.license?.source === "unsure") return { ok: false, gate: "license", message: "\u6587\u6863\u5934\u7684\u6388\u6743\u6765\u6E90\u8FD8\u662F\u300C\u4E0D\u786E\u5B9A\u300D\uFF0C\u6539\u4E00\u4EFD\u6559\u6750\u7684\u6765\u6E90\u5C31\u4F1A\u91CD\u7B97" };
  const texts = Array.isArray(materialTexts) ? materialTexts.filter((t) => t && t.text) : [];
  if (!texts.length) return { ok: false, gate: "cleanCheck", message: "\u8FD9\u95E8\u8BFE\u6CA1\u6709\u6559\u6750\u6587\u672C\uFF0C\u6CC4\u6F0F\u6838\u67E5\u6CA1\u6CD5\u8DD1 \u2014\u2014 \u53D1\u5E03\u524D\u5FC5\u987B\u67E5\u8FC7\uFF08\u5148\u767B\u8BB0\u6709\u5757\u7EA7\u6587\u672C\u7684\u6559\u6750\uFF09" };
  const built = (0, import_export.buildExport)(doc, { audience: "market", materials: texts, now });
  if (!built.ok) return { ok: false, gate: built.code === "CLEAN_CHECK" ? "cleanCheck" : "doc", message: built.message, ...built.clean ? { details: { clean: built.clean } } : {} };
  if (!adultDeclared) return { ok: false, gate: "adult", message: "\u5148\u505A\u6210\u4EBA\u58F0\u660E\uFF08\u843D\u5730\u9875\u7B2C\u4E00\u6B21\u8FDB\u6765\u90A3\u4E00\u6B65\uFF09\u518D\u53D1\u5E03" };
  if (body.aigcDeclared !== true) return { ok: false, gate: "aigc", message: "\u53D1\u5E03\u524D\u8981\u4E3B\u52A8\u58F0\u660E\u300C\u8FD9\u4F4D\u8001\u5E08\u542B AI \u751F\u6210\u5185\u5BB9\u300D\u2014\u2014 \u52FE\u4E0A\u90A3\u4E00\u9879\uFF08\u300A\u6807\u8BC6\u529E\u6CD5\u300B\u7B2C\u5341\u6761\uFF09" };
  if (!name) return { ok: false, gate: "name", message: "\u8001\u5E08\u5F97\u6709\u4E2A\u540D\u5B57" };
  const hint = (0, import_demo.realNameHint)(name);
  if (hint) return { ok: false, gate: "name", message: hint };
  return { ok: true, built, name, tags };
}
function previewOf(doc) {
  const card = doc?.card || {};
  const rules = Array.isArray(card.hard_rules) ? card.hard_rules : [];
  const st = (id) => doc.distill?.[id] || {};
  return {
    card: { who: card.who || "", teaching_style: card.teaching_style || "", catchphrases: Array.isArray(card.catchphrases) ? card.catchphrases : [], hard_rules: rules.map((r) => typeof r === "string" ? { text: r, locked: false } : { text: r.text || "", locked: !!r.locked }) },
    stages: (doc.map?.stages || []).map((s) => ({ stage_id: s.stage_id, title: s.title, summary: s.summary || "", steps: (st(s.stage_id).walkthrough || []).length, memo: (st(s.stage_id).must_memorize || []).length, checks: (st(s.stage_id).self_checks || []).length })),
    guide: typeof doc.guide === "string" ? doc.guide : "",
    subject: doc.subject || "",
    course: doc.course || null,
    language: doc.language || "",
    policy: doc.policy || null,
    license: doc.license || null
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_COVER,
  GATES,
  TAGS_MAX,
  TAG_MAX_LEN,
  checkGates,
  previewOf
});
