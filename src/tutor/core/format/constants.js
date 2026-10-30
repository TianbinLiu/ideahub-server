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
var constants_exports = {};
__export(constants_exports, {
  AIGC_KEYS: () => AIGC_KEYS,
  AIGC_LABEL_GENERATED: () => AIGC_LABEL_GENERATED,
  ANCHOR_RE: () => ANCHOR_RE,
  ANCHOR_TAIL_RE: () => ANCHOR_TAIL_RE,
  AUDIENCES: () => AUDIENCES,
  CARD_SUBS: () => CARD_SUBS,
  DISTILL_SUBS: () => DISTILL_SUBS,
  EMPTY_NOTES: () => EMPTY_NOTES,
  EXPLICIT_LABEL_RE: () => EXPLICIT_LABEL_RE,
  FORMAT_ID: () => FORMAT_ID,
  FORMAT_MAJOR: () => FORMAT_MAJOR,
  FORMAT_MINOR: () => FORMAT_MINOR,
  FORMAT_NAME: () => FORMAT_NAME,
  GUIDE_SUBS: () => GUIDE_SUBS,
  HOMEWORK_MODES: () => HOMEWORK_MODES,
  KEY_DATE_KINDS: () => KEY_DATE_KINDS,
  LICENSE_SOURCES: () => LICENSE_SOURCES,
  LIMITS: () => LIMITS,
  LOG_INCLUDES: () => LOG_INCLUDES,
  MAP_COLUMNS: () => MAP_COLUMNS,
  MAP_SUBS: () => MAP_SUBS,
  POLICY_AI: () => POLICY_AI,
  PRODUCE_ID_NAMESPACE: () => PRODUCE_ID_NAMESPACE,
  PROFILE_INCLUDES: () => PROFILE_INCLUDES,
  PROFILE_SUBS: () => PROFILE_SUBS,
  SECTIONS: () => SECTIONS,
  SELF_CHECK_KINDS: () => SELF_CHECK_KINDS,
  SELF_CHECK_KINDS_REV: () => SELF_CHECK_KINDS_REV,
  SHA256_RE: () => SHA256_RE,
  STAGED_META_TAIL_RE: () => STAGED_META_TAIL_RE,
  STAGE_ID_RE: () => STAGE_ID_RE,
  STAGE_STATUS: () => STAGE_STATUS,
  STAGE_STATUS_EN: () => STAGE_STATUS_EN,
  contentIdOf: () => contentIdOf,
  explicitLabelLine: () => explicitLabelLine,
  parseAnchorMatch: () => parseAnchorMatch,
  parseSeqs: () => parseSeqs,
  parseStagedMeta: () => parseStagedMeta,
  renderAnchor: () => renderAnchor,
  renderSeqs: () => renderSeqs,
  renderStagedMeta: () => renderStagedMeta
});
module.exports = __toCommonJS(constants_exports);
const FORMAT_NAME = "ideahub-tutor";
const FORMAT_MAJOR = 1;
const FORMAT_MINOR = 1;
const FORMAT_ID = `${FORMAT_NAME}/${FORMAT_MAJOR}.${FORMAT_MINOR}`;
const SECTIONS = [
  { key: "card", num: "\u2460", zh: "\u8001\u5E08\u4EBA\u683C\u5361", en: "Teacher Card" },
  { key: "profile", num: "\u2461", zh: "\u5B66\u751F\u753B\u50CF", en: "Learner Profile" },
  { key: "map", num: "\u2462", zh: "\u8BFE\u7A0B\u5730\u56FE", en: "Course Map" },
  { key: "distill", num: "\u2463", zh: "\u77E5\u8BC6\u84B8\u998F", en: "Distillation" },
  { key: "log", num: "\u2464", zh: "\u5BF9\u8BDD\u65E5\u5FD7", en: "Dialogue Log" },
  { key: "guide", num: "\u2465", zh: "\u590D\u523B\u6307\u5357", en: "Replication Guide" }
];
const CARD_SUBS = [
  { key: "who", zh: "\u662F\u8C01", en: "Who" },
  { key: "catchphrases", zh: "\u53E3\u5934\u7985", en: "Catchphrases" },
  { key: "teaching_style", zh: "\u6559\u5B66\u98CE\u683C", en: "Teaching Style" },
  { key: "hard_rules", zh: "\u786C\u89C4\u5219", en: "Hard Rules" },
  { key: "greeting_closing", zh: "\u5F00\u573A\u4E0E\u6536\u5C3E", en: "Greeting and Closing" },
  { key: "example_turns", zh: "\u793A\u4F8B\u5BF9\u8BDD", en: "Example Turns" }
];
const PROFILE_SUBS = [
  { key: "pace", zh: "\u5B66\u4E60\u8282\u594F", en: "Pace" },
  { key: "preferences", zh: "\u504F\u597D", en: "Preferences" },
  { key: "stuck_points", zh: "\u5361\u70B9", en: "Stuck Points" },
  { key: "effective_methods", zh: "\u6709\u6548\u8BB2\u6CD5", en: "Effective Methods" },
  { key: "misconceptions", zh: "\u8BEF\u89E3", en: "Misconceptions" }
];
const MAP_COLUMNS = [
  { key: "week", zh: "\u5468", en: "Week" },
  { key: "stage_id", zh: "\u9636\u6BB5 id", en: "Stage" },
  { key: "title", zh: "\u4E3B\u9898", en: "Topic" },
  { key: "status", zh: "\u72B6\u6001", en: "Status" },
  { key: "key_date", zh: "\u5173\u952E\u65E5\u671F", en: "Key Date" },
  { key: "summary", zh: "\u6458\u8981", en: "Summary" }
];
const MAP_SUBS = [
  { key: "key_dates", zh: "\u5173\u952E\u65E5\u671F", en: "Key Dates" },
  // 1.0 定稿补的可选标题：source_material_hashes 在字段表里（§4.3），md 里原来没处放。
  { key: "source_material_hashes", zh: "\u6559\u6750\u6307\u7EB9", en: "Material Hashes" }
];
const DISTILL_SUBS = [
  { key: "method", zh: "\u8001\u5E08\u7684\u8BB2\u6CD5", en: "How the Teacher Explains" },
  // 1.1 新增：导学漫游的脚本 —— 每一步锚在教材的一处，老师说一句、可选反问一句（docs/03 §4.7）。1.0 读者当未知四级标题原样保留
  { key: "walkthrough", zh: "\u8BB2\u89E3\u6B65", en: "Walkthrough" },
  { key: "must_memorize", zh: "\u5FC5\u80CC", en: "Must Memorize" },
  { key: "self_checks", zh: "\u81EA\u68C0\u9898", en: "Self-checks" },
  { key: "student_qa", zh: "\u5B66\u751F\u95EE\u7B54", en: "Student Q&A" },
  { key: "pitfalls", zh: "\u6613\u9519\u70B9", en: "Pitfalls" }
];
const GUIDE_SUBS = [
  { key: "system_prompt", zh: "\u7ED9\u4EFB\u610F AI \u7684\u4E00\u6BB5\u8BDD", en: "A Note for Any AI" },
  { key: "how_to_continue", zh: "\u600E\u4E48\u63A5\u7740\u4E0A", en: "How to Continue" },
  { key: "how_to_update_profile", zh: "\u600E\u4E48\u66F4\u65B0\u5B66\u751F\u753B\u50CF", en: "How to Update the Learner Profile" },
  { key: "boundaries", zh: "\u8FB9\u754C", en: "Boundaries" }
];
const STAGE_STATUS = ["\u672A\u8BB2", "\u5DF2\u8BB2", "\u5B66\u751F\u5DF2\u901A\u8FC7"];
const STAGE_STATUS_EN = { "\u672A\u8BB2": "not taught", "\u5DF2\u8BB2": "taught", "\u5B66\u751F\u5DF2\u901A\u8FC7": "passed" };
const SELF_CHECK_KINDS = { "\u8BA1\u7B97": "calc", "\u6982\u5FF5": "concept", "\u6392\u9519": "debug" };
const SELF_CHECK_KINDS_REV = Object.fromEntries(Object.entries(SELF_CHECK_KINDS).map(([zh, en]) => [en, zh]));
const KEY_DATE_KINDS = ["exam", "homework", "project", "other"];
const LICENSE_SOURCES = ["self", "instructor_public", "instructor_consent", "unsure"];
const POLICY_AI = ["prohibited", "limited", "allowed"];
const HOMEWORK_MODES = ["principles_only", "full"];
const AUDIENCES = ["market", "self"];
const PROFILE_INCLUDES = ["none", "seed", "full"];
const LOG_INCLUDES = ["none", "excerpts", "full"];
const STAGE_ID_RE = /^stage-\d{2,3}$/;
const SHA256_RE = /^(sha256:)?[0-9a-f]{64}$/;
const LIMITS = {
  file_bytes: { max: 1024 * 1024, suggested: true },
  // §2：S2 给 /api/tutor 2 MB JSON 上限，留一倍给转义膨胀
  version_note: 300,
  name: 120,
  subject: 60,
  tags: { count: 6, each: 10 },
  card: {
    who: 1e3,
    catchphrases: { count: 12, each: 120 },
    teaching_style: 2e3,
    tone: 300,
    address_student: 60,
    hard_rules: { count: 12, each: 120 },
    greeting: 300,
    closing: 300,
    example_turns: { count: 12, each: 300 }
  },
  profile: {
    pace: 200,
    preferences: { count: 10, each: 120 },
    stuck_points: { count: 30, each: 200 },
    effective_methods: { count: 20, each: 200 },
    misconceptions: { count: 30, each: 200 }
  },
  map: {
    stages: 60,
    title: 80,
    summary: 300,
    key_date: 60,
    key_dates: { count: 30, label: 60 }
  },
  distill: {
    method: 1500,
    walkthrough: { count: 12, say: 300, ask: 200 },
    // 一阶段 ≤ 12 步（建议值：一页幻灯 1～2 步、一阶段 6～8 页）
    anchor_quote: 40,
    // 锚点短引 ≤ 40 字：够重新对上、又远低于泄漏核查阈值 120，属合理引用（docs/09 §5.2）
    must_memorize: { count: 12, each: 200 },
    self_checks: { count: 8, q: 300, a: 500, rubric: 200, min_for_market: 2 },
    student_qa: { count: 10, q: 300, a: 500 },
    pitfalls: { count: 10, each: 200 },
    per_stage_chars: { max: 3e3, suggested: true }
    // §4.4：一次一阶段要整段塞进上下文
  },
  log: {
    excerpts: 20,
    why: 200,
    turns: { count: 12, each: 1e3 }
  },
  guide: {
    system_prompt: 2e3,
    // §4.6：塞进任何聊天窗口的一条消息（Character.AI Definition 32000 字符可对照）
    how_to_continue: 1500,
    how_to_update_profile: 1500,
    boundaries: 1e3
  }
};
function explicitLabelLine({ producer, id, version }) {
  return `> \u672C\u6587\u4EF6\u4E3A\u4EBA\u5DE5\u667A\u80FD\u751F\u6210\u5408\u6210\u5185\u5BB9\uFF08${producer} \xB7 \u8001\u5E08\u4EBA\u683C ${id} v${version}\uFF09\u3002`;
}
const EXPLICIT_LABEL_RE = /^>\s*本文件为人工智能生成合成内容（(.+?) · 老师人格 (\S+) v(\d+)）。\s*$/;
const AIGC_KEYS = ["Label", "ContentProducer", "ProduceID", "ReservedCode1", "ContentPropagator", "PropagateID", "ReservedCode2"];
const AIGC_LABEL_GENERATED = "1";
const PRODUCE_ID_NAMESPACE = "6f3c9a4e-2c1b-4f0a-9d7e-8b5a1c2d3e4f";
function contentIdOf({ id, version }) {
  return `tutor:${id}:v${version}`;
}
const ANCHOR_RE = /〔m:([0-9a-f]{12}) p(\d+)(?: #([0-9a-f]{12}))?(?: (\d+)-(\d+))?「([^」]{1,40})」〕/;
const ANCHOR_TAIL_RE = new RegExp(`\\s*${ANCHOR_RE.source}\\s*$`);
function renderAnchor(a) {
  const parts = [`m:${a.material}`, `p${a.page}`];
  if (a.chunk) parts.push(`#${a.chunk}`);
  if (a.start !== void 0 && a.end !== void 0) parts.push(`${a.start}-${a.end}`);
  return `\u3014${parts.join(" ")}\u300C${a.quote}\u300D\u3015`;
}
function parseAnchorMatch(m) {
  const a = { material: m[1], page: Number(m[2]), quote: m[6] };
  if (m[3]) a.chunk = m[3];
  if (m[4] !== void 0) {
    a.start = Number(m[4]);
    a.end = Number(m[5]);
  }
  return a;
}
const STAGED_META_TAIL_RE = /\s*‹([^‹›]+)›\s*$/;
const META_KEYS = [["\u9996\u89C1", "first_seen"], ["\u672B\u89C1", "last_seen"], ["\u5DF2\u89E3", "resolved_at"]];
function renderStagedMeta(x) {
  const parts = [];
  if (x.evidence?.length) parts.push(`t:${renderSeqs(x.evidence)}`);
  for (const [zh, key] of META_KEYS) if (x[key]) parts.push(`${zh} ${x[key]}`);
  return parts.length ? `\u2039${parts.join(" \xB7 ")}\u203A` : "";
}
function renderSeqs(seqs) {
  const out = [];
  for (let i = 0; i < seqs.length; ) {
    let j = i;
    while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j++;
    if (j - i >= 2) {
      out.push(`${seqs[i]}\u2013${seqs[j]}`);
      i = j + 1;
    } else {
      out.push(String(seqs[i]));
      i++;
    }
  }
  return out.join(",");
}
function parseSeqs(s) {
  const out = [];
  for (const tok of s.split(",")) {
    const m = /^(\d+)(?:[–-](\d+))?$/.exec(tok);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === void 0 ? a : Number(m[2]);
    if (b < a) return null;
    for (let k = a; k <= b; k++) out.push(k);
  }
  return out;
}
function parseStagedMeta(inner) {
  const out = {};
  for (const part of inner.split(/\s*·\s*/)) {
    let m;
    if (m = /^t:(\S+)$/.exec(part)) {
      const seqs = parseSeqs(m[1]);
      if (!seqs) return null;
      out.evidence = seqs;
    } else if (m = /^(首见|末见|已解)\s+(\S+)$/.exec(part)) out[META_KEYS.find(([zh]) => zh === m[1])[1]] = m[2];
    else return null;
  }
  return Object.keys(out).length ? out : null;
}
const EMPTY_NOTES = {
  stuck_points: "\uFF08\u4F5C\u8005\u672A\u52FE\u9009\u4EFB\u4F55\u5361\u70B9\u968F\u4EBA\u683C\u53D1\u5E03\u3002\uFF09",
  student_qa: "\uFF08\u4F5C\u8005\u672A\u52FE\u9009\u3002\uFF09"
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AIGC_KEYS,
  AIGC_LABEL_GENERATED,
  ANCHOR_RE,
  ANCHOR_TAIL_RE,
  AUDIENCES,
  CARD_SUBS,
  DISTILL_SUBS,
  EMPTY_NOTES,
  EXPLICIT_LABEL_RE,
  FORMAT_ID,
  FORMAT_MAJOR,
  FORMAT_MINOR,
  FORMAT_NAME,
  GUIDE_SUBS,
  HOMEWORK_MODES,
  KEY_DATE_KINDS,
  LICENSE_SOURCES,
  LIMITS,
  LOG_INCLUDES,
  MAP_COLUMNS,
  MAP_SUBS,
  POLICY_AI,
  PRODUCE_ID_NAMESPACE,
  PROFILE_INCLUDES,
  PROFILE_SUBS,
  SECTIONS,
  SELF_CHECK_KINDS,
  SELF_CHECK_KINDS_REV,
  SHA256_RE,
  STAGED_META_TAIL_RE,
  STAGE_ID_RE,
  STAGE_STATUS,
  STAGE_STATUS_EN,
  contentIdOf,
  explicitLabelLine,
  parseAnchorMatch,
  parseSeqs,
  parseStagedMeta,
  renderAnchor,
  renderSeqs,
  renderStagedMeta
});
