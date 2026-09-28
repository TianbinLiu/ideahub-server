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
var assemble_exports = {};
__export(assemble_exports, {
  DEFAULT_PRODUCER: () => DEFAULT_PRODUCER,
  assembleDoc: () => assembleDoc,
  licenseSourceOf: () => licenseSourceOf,
  newDocId: () => newDocId,
  seedDoc: () => seedDoc
});
module.exports = __toCommonJS(assemble_exports);
var import_node_crypto = require("node:crypto");
var import_constants = require("../format/constants.js");
var import_format = require("../format/index.js");
var import_ops = require("../ops/index.js");
const DEFAULT_PRODUCER = "\u542F\u68A6\u521B\u4F5C";
const newDocId = () => (0, import_node_crypto.randomBytes)(12).toString("hex");
function licenseSourceOf(materials) {
  const rank = Object.fromEntries(import_constants.LICENSE_SOURCES.map((s, i) => [s, i]));
  let worst = "self";
  for (const m of materials || []) {
    const s = m.license?.source || "unsure";
    if ((rank[s] ?? 3) > rank[worst]) worst = s;
  }
  return worst;
}
function seedDoc({ id = newDocId(), version = 1, supersedes, course, card, guide, hashes, materials, author = { username: "local", uid: 0 }, producer = DEFAULT_PRODUCER, method, now = /* @__PURE__ */ new Date(), language = "zh" }) {
  const policy = course.policy || {};
  const doc = {
    format: import_constants.FORMAT_ID,
    id,
    version,
    ...supersedes ? { supersedes, version_note: "\u91CD\u65B0\u751F\u6210" } : {},
    name: card.name,
    subject: course.subject,
    course: { ...course.code ? { code: course.code } : {}, title: course.title, ...course.term ? { term: course.term } : {} },
    language,
    tags: [course.subject, card.style_label].filter(Boolean).map((t) => String(t).slice(0, 10)).slice(0, 6),
    author,
    license: { source: licenseSourceOf(materials), terms: "private", materials_included: false },
    policy: { ai: policy.ai || "limited", homework_mode: policy.homework_mode || "principles_only", allowed_uses: (policy.allowed_uses || []).slice(0, 12), text: String(policy.text || "").slice(0, 2e3) },
    includes_student_profile: "full",
    includes_dialogue_log: "none",
    stages: 0,
    fork_of: null,
    AIGC: { Label: "1", ContentProducer: producer, ProduceID: "", ReservedCode1: "", ContentPropagator: "", PropagateID: "", ReservedCode2: "" },
    provenance: { generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"), method: String(method).slice(0, 200) },
    audience: "self",
    card: { who: card.who, catchphrases: card.catchphrases, teaching_style: card.teaching_style, ...card.tone ? { tone: card.tone } : {}, ...card.address_student ? { address_student: card.address_student } : {}, hard_rules: card.hard_rules, ...card.greeting ? { greeting: card.greeting } : {}, ...card.closing ? { closing: card.closing } : {}, example_turns: card.example_turns || [] },
    profile: { pace: "", preferences: [], stuck_points: [], effective_methods: [], misconceptions: [] },
    map: { stages: [], key_dates: (course.key_dates || []).map((d) => ({ label: String(d.label).slice(0, 60), at: String(d.at), kind: d.kind || "other" })), source_material_hashes: hashes },
    distill: {},
    log_excerpts: [],
    guide,
    raw: { frontmatter: {}, notes: {}, leftovers: {}, subsections: [], sections: [] }
    // 与 parse.js 起手的 raw 同形
  };
  doc.AIGC.ProduceID = (0, import_format.expectedProduceId)(doc);
  return doc;
}
async function assembleDoc(seed, proposals) {
  const ops = proposals.map((p) => ({ op: "map.stage.propose", path: "/map/stages", value: p.value, evidence: [], rationale: p.rationale || "" }));
  const v = (0, import_ops.validateOpsBatch)(ops, { source: "scan", runId: seed.id, doc: seed });
  if (!v.ok) throw new Error(`\u9636\u6BB5\u63D0\u8BAE\u4E0D\u5408\u767D\u540D\u5355\uFF1A${v.errors.join("\uFF1B")}`);
  const { doc, results } = await (0, import_ops.applyOps)(seed, v.ops, { confirm: async () => true });
  const check = (0, import_format.validateTutorDoc)(doc, { requireLabels: false });
  if (!check.ok) throw new Error(`\u7EC4\u88C5\u51FA\u7684\u6587\u6863\u4E0D\u5408\u89C4\u8303\uFF1A${check.errors.join("\uFF1B")}`);
  const { text, checksum } = (0, import_format.renderTutorDoc)(doc);
  return { doc, text, checksum, results, warnings: check.warnings };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_PRODUCER,
  assembleDoc,
  licenseSourceOf,
  newDocId,
  seedDoc
});
