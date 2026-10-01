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
var schema_exports = {};
__export(schema_exports, {
  AnchorSchema: () => AnchorSchema,
  CardSchema: () => CardSchema,
  DistillStageSchema: () => DistillStageSchema,
  ExcerptSchema: () => ExcerptSchema,
  FrontmatterSchema: () => FrontmatterSchema,
  GuideSchema: () => GuideSchema,
  HardRuleSchema: () => HardRuleSchema,
  MapSchema: () => MapSchema,
  ProfileSchema: () => ProfileSchema,
  SelfCheckSchema: () => SelfCheckSchema,
  StageSchema: () => StageSchema,
  TutorDocSchema: () => TutorDocSchema,
  WalkthroughStepSchema: () => WalkthroughStepSchema,
  issuesToLines: () => issuesToLines
});
module.exports = __toCommonJS(schema_exports);
var import_zod = require("zod");
var import_constants = require("./constants.js");
const str = (max) => import_zod.z.string().max(max);
const AnchorSchema = import_zod.z.object({
  material: import_zod.z.string().regex(/^[0-9a-f]{12}$/, "material \u662F\u6559\u6750 sha256 \u7684\u524D 12 \u4F4D"),
  page: import_zod.z.number().int().min(1),
  chunk: import_zod.z.string().regex(/^[0-9a-f]{12}$/).optional(),
  start: import_zod.z.number().int().min(0).optional(),
  end: import_zod.z.number().int().min(1).optional(),
  quote: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.anchor_quote)
}).refine((a) => a.start === void 0 === (a.end === void 0), { message: "start \u4E0E end \u8981\u6210\u5BF9" }).refine((a) => a.start === void 0 || a.start < a.end, { message: "start \u5FC5\u987B\u5C0F\u4E8E end" });
const anchored = (max) => import_zod.z.union([str(max).min(1), import_zod.z.object({ text: str(max).min(1), anchor: AnchorSchema })]);
const strArr = (count, each) => import_zod.z.array(str(each)).max(count);
const stageId = import_zod.z.string().regex(import_constants.STAGE_ID_RE, "stage_id \u5FC5\u987B\u662F stage-NN\uFF08\u4E24\u4F4D\u8D77\uFF0C\u53EF\u5230\u4E09\u4F4D\uFF09");
const isoDate = import_zod.z.string().regex(/^\d{4}-\d{2}-\d{2}/, "\u65E5\u671F\u5199 YYYY-MM-DD");
const FrontmatterSchema = import_zod.z.object({
  format: import_zod.z.string().regex(/^[a-z][a-z0-9-]*\/\d+\.\d+$/, "format \u5199\u6210 \u540D\u5B57/\u4E3B.\u6B21\uFF0C\u4F8B\u5982 ideahub-tutor/1.0"),
  id: import_zod.z.string().min(1).max(64),
  version: import_zod.z.number().int().min(1),
  supersedes: import_zod.z.number().int().min(1).nullable().optional(),
  /** 被哪一版取代（正向指针，HF Model Card 的 new_version 同型；读者拿到旧版时能顺着找新版）。服务端发新版时写进旧版的 JSON 镜像 */
  superseded_by: import_zod.z.number().int().min(1).nullable().optional(),
  version_note: str(import_constants.LIMITS.version_note).optional(),
  name: str(import_constants.LIMITS.name).min(1),
  subject: str(import_constants.LIMITS.subject).min(1),
  course: import_zod.z.object({
    code: import_zod.z.string().max(60).optional(),
    title: import_zod.z.string().max(120).min(1),
    school: import_zod.z.string().max(120).optional(),
    term: import_zod.z.string().max(40).optional()
  }),
  language: import_zod.z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "language \u7528 BCP 47 \u4E3B\u6807\u7B7E\uFF0C\u5982 zh / en"),
  tags: strArr(import_constants.LIMITS.tags.count, import_constants.LIMITS.tags.each).optional(),
  author: import_zod.z.object({ username: import_zod.z.string().min(1).max(60), uid: import_zod.z.number().int().min(0) }),
  license: import_zod.z.object({
    source: import_zod.z.enum(import_constants.LICENSE_SOURCES),
    terms: import_zod.z.string().max(60),
    // 恒 false：写 true 整句拒（docs/03 §3）。用 literal 而不是 boolean，让「拒」发生在形状检查这一层。
    materials_included: import_zod.z.literal(false, { message: "materials_included \u53EA\u80FD\u662F false\uFF1A\u6559\u6750\u539F\u4EF6\u6C38\u4E0D\u968F\u4EBA\u683C\u5206\u53D1" })
  }),
  policy: import_zod.z.object({
    ai: import_zod.z.enum(import_constants.POLICY_AI),
    homework_mode: import_zod.z.enum(import_constants.HOMEWORK_MODES),
    allowed_uses: import_zod.z.array(import_zod.z.string().max(60)).max(12).optional(),
    text: import_zod.z.string().max(2e3)
  }),
  includes_student_profile: import_zod.z.enum(import_constants.PROFILE_INCLUDES),
  includes_dialogue_log: import_zod.z.enum(import_constants.LOG_INCLUDES),
  stages: import_zod.z.number().int().min(0),
  fork_of: import_zod.z.object({ id: import_zod.z.string().min(1), version: import_zod.z.number().int().min(1) }).nullable().optional(),
  // GB 45438-2025 附录 E 的七个字段，键名大小写照标准（constants.AIGC_KEYS）；全部收字符串，空串 = 留空
  AIGC: import_zod.z.object({
    Label: import_zod.z.enum(["1", "2", "3"]),
    ContentProducer: import_zod.z.string().min(1).max(120),
    ProduceID: import_zod.z.string().min(1).max(64),
    ReservedCode1: import_zod.z.string().max(64).optional(),
    ContentPropagator: import_zod.z.string().max(120).optional(),
    PropagateID: import_zod.z.string().max(64).optional(),
    ReservedCode2: import_zod.z.string().max(64).optional()
  }),
  /** 附录 E 之外的来历说明（生成时间、方法），放在 AIGC 键之外以免污染标准记录 */
  provenance: import_zod.z.object({ generated_at: import_zod.z.string().max(40), method: import_zod.z.string().max(200) }).optional(),
  exported_at: import_zod.z.string().max(40).optional(),
  audience: import_zod.z.enum(import_constants.AUDIENCES),
  checksum: import_zod.z.string().regex(import_constants.SHA256_RE, "checksum \u5199\u6210 sha256:<64 \u4F4D\u5341\u516D\u8FDB\u5236>").optional(),
  deprecated_since: import_zod.z.string().max(40).optional()
});
const HardRuleSchema = import_zod.z.object({
  text: str(import_constants.LIMITS.card.hard_rules.each).min(1),
  locked: import_zod.z.boolean(),
  from: import_zod.z.enum(["policy", "author"])
});
const CardSchema = import_zod.z.object({
  who: str(import_constants.LIMITS.card.who),
  catchphrases: strArr(import_constants.LIMITS.card.catchphrases.count, import_constants.LIMITS.card.catchphrases.each),
  teaching_style: str(import_constants.LIMITS.card.teaching_style),
  tone: str(import_constants.LIMITS.card.tone).optional(),
  address_student: str(import_constants.LIMITS.card.address_student).optional(),
  hard_rules: import_zod.z.array(HardRuleSchema).max(import_constants.LIMITS.card.hard_rules.count),
  greeting: str(import_constants.LIMITS.card.greeting).optional(),
  closing: str(import_constants.LIMITS.card.closing).optional(),
  example_turns: import_zod.z.array(import_zod.z.object({
    student: str(import_constants.LIMITS.card.example_turns.each),
    teacher: str(import_constants.LIMITS.card.example_turns.each)
  })).max(import_constants.LIMITS.card.example_turns.count)
});
const staged = (each) => import_zod.z.object({
  stage_id: stageId,
  text: str(each).min(1),
  anchor: AnchorSchema.optional(),
  first_seen: import_zod.z.string().optional(),
  last_seen: import_zod.z.string().optional(),
  resolved_at: import_zod.z.string().optional(),
  evidence: import_zod.z.array(import_zod.z.number().int()).optional()
});
const ProfileSchema = import_zod.z.object({
  pace: str(import_constants.LIMITS.profile.pace),
  preferences: strArr(import_constants.LIMITS.profile.preferences.count, import_constants.LIMITS.profile.preferences.each),
  stuck_points: import_zod.z.array(staged(import_constants.LIMITS.profile.stuck_points.each)).max(import_constants.LIMITS.profile.stuck_points.count),
  effective_methods: import_zod.z.array(staged(import_constants.LIMITS.profile.effective_methods.each)).max(import_constants.LIMITS.profile.effective_methods.count),
  misconceptions: import_zod.z.array(staged(import_constants.LIMITS.profile.misconceptions.each)).max(import_constants.LIMITS.profile.misconceptions.count),
  mastery: import_zod.z.record(import_zod.z.string(), import_zod.z.object({
    attempts: import_zod.z.number().int(),
    last_verdict: import_zod.z.string().optional(),
    passed_at: import_zod.z.string().optional(),
    next_review_at: import_zod.z.string().optional()
  })).optional(),
  updated_at: import_zod.z.string().optional()
});
const StageSchema = import_zod.z.object({
  stage_id: stageId,
  week: import_zod.z.union([import_zod.z.number().int(), import_zod.z.string().max(20)]),
  title: str(import_constants.LIMITS.map.title).min(1),
  summary: str(import_constants.LIMITS.map.summary),
  status: import_zod.z.enum(import_constants.STAGE_STATUS),
  key_date: str(import_constants.LIMITS.map.key_date),
  renamed_from: stageId.optional()
});
const MapSchema = import_zod.z.object({
  stages: import_zod.z.array(StageSchema).max(import_constants.LIMITS.map.stages),
  key_dates: import_zod.z.array(import_zod.z.object({
    label: str(import_constants.LIMITS.map.key_dates.label).min(1),
    at: isoDate,
    kind: import_zod.z.enum(import_constants.KEY_DATE_KINDS)
  })).max(import_constants.LIMITS.map.key_dates.count),
  source_material_hashes: import_zod.z.array(import_zod.z.string().regex(import_constants.SHA256_RE)).optional()
});
const SelfCheckSchema = import_zod.z.object({
  q: str(import_constants.LIMITS.distill.self_checks.q).min(1),
  a: str(import_constants.LIMITS.distill.self_checks.a),
  kind: import_zod.z.enum(["calc", "concept", "debug"]),
  rubric: str(import_constants.LIMITS.distill.self_checks.rubric).optional(),
  anchor: AnchorSchema.optional()
});
const WalkthroughStepSchema = import_zod.z.object({
  say: str(import_constants.LIMITS.distill.walkthrough.say).min(1),
  ask: str(import_constants.LIMITS.distill.walkthrough.ask).optional(),
  anchor: AnchorSchema.optional()
});
const DistillStageSchema = import_zod.z.object({
  title: str(import_constants.LIMITS.map.title).optional(),
  method: str(import_constants.LIMITS.distill.method),
  walkthrough: import_zod.z.array(WalkthroughStepSchema).max(import_constants.LIMITS.distill.walkthrough.count).optional(),
  must_memorize: import_zod.z.array(anchored(import_constants.LIMITS.distill.must_memorize.each)).max(import_constants.LIMITS.distill.must_memorize.count),
  self_checks: import_zod.z.array(SelfCheckSchema).max(import_constants.LIMITS.distill.self_checks.count),
  student_qa: import_zod.z.array(import_zod.z.object({
    q: str(import_constants.LIMITS.distill.student_qa.q).min(1),
    a: str(import_constants.LIMITS.distill.student_qa.a),
    from_turn: import_zod.z.number().int().optional(),
    anchor: AnchorSchema.optional()
  })).max(import_constants.LIMITS.distill.student_qa.count),
  pitfalls: import_zod.z.array(anchored(import_constants.LIMITS.distill.pitfalls.each)).max(import_constants.LIMITS.distill.pitfalls.count),
  raw: import_zod.z.array(import_zod.z.string()).optional()
});
const ExcerptSchema = import_zod.z.object({
  stage_id: stageId,
  turn_from: import_zod.z.number().int().optional(),
  turn_to: import_zod.z.number().int().optional(),
  why: str(import_constants.LIMITS.log.why),
  turns: import_zod.z.array(import_zod.z.object({
    role: import_zod.z.enum(["student", "teacher"]),
    text: str(import_constants.LIMITS.log.turns.each)
  })).max(import_constants.LIMITS.log.turns.count)
});
const GuideSchema = import_zod.z.object({
  system_prompt: str(import_constants.LIMITS.guide.system_prompt),
  how_to_continue: str(import_constants.LIMITS.guide.how_to_continue),
  how_to_update_profile: str(import_constants.LIMITS.guide.how_to_update_profile),
  boundaries: str(import_constants.LIMITS.guide.boundaries)
});
const TutorDocSchema = FrontmatterSchema.extend({
  card: CardSchema,
  profile: ProfileSchema,
  map: MapSchema,
  distill: import_zod.z.record(stageId, DistillStageSchema),
  log_excerpts: import_zod.z.array(ExcerptSchema).max(import_constants.LIMITS.log.excerpts),
  guide: GuideSchema,
  raw: import_zod.z.object({
    frontmatter: import_zod.z.record(import_zod.z.string(), import_zod.z.unknown()).optional(),
    notes: import_zod.z.record(import_zod.z.string(), import_zod.z.string()).optional(),
    subsections: import_zod.z.array(import_zod.z.object({ section: import_zod.z.string(), after: import_zod.z.string().nullable(), heading: import_zod.z.string(), text: import_zod.z.string() })).optional(),
    sections: import_zod.z.array(import_zod.z.object({ after: import_zod.z.string(), heading: import_zod.z.string(), text: import_zod.z.string() })).optional()
  }).optional()
});
function issuesToLines(issues) {
  return issues.map((i) => `${i.path.length ? i.path.join(".") : "(\u6839)"}\uFF1A${i.message}`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AnchorSchema,
  CardSchema,
  DistillStageSchema,
  ExcerptSchema,
  FrontmatterSchema,
  GuideSchema,
  HardRuleSchema,
  MapSchema,
  ProfileSchema,
  SelfCheckSchema,
  StageSchema,
  TutorDocSchema,
  WalkthroughStepSchema,
  issuesToLines
});
