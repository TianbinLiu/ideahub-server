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
var catalog_exports = {};
__export(catalog_exports, {
  AnchorSchema: () => import_schema.AnchorSchema,
  FORBIDDEN_PATHS: () => FORBIDDEN_PATHS,
  MAX_OPS_PER_BATCH: () => MAX_OPS_PER_BATCH,
  OP_CATALOG: () => OP_CATALOG,
  SOURCE_LABELS: () => SOURCE_LABELS,
  catalogForPrompt: () => catalogForPrompt,
  sourcesOf: () => sourcesOf
});
module.exports = __toCommonJS(catalog_exports);
var import_zod = require("zod");
var import_constants = require("../format/constants.js");
var import_schema = require("../format/schema.js");
const stageId = import_zod.z.string().regex(import_constants.STAGE_ID_RE);
const staged = (max) => import_zod.z.object({ stage_id: stageId, text: import_zod.z.string().min(1).max(max) });
const STAGE_PATH = "(stage-\\d{2,3})";
const OP_CATALOG = {
  "profile.pace.set": { path: /^\/profile\/pace$/, mode: "auto", scope: "learner", minEvidence: 1, value: import_zod.z.string().min(1).max(import_constants.LIMITS.profile.pace) },
  "profile.preference.add": { path: /^\/profile\/preferences$/, mode: "auto", scope: "learner", minEvidence: 1, value: import_zod.z.string().min(1).max(import_constants.LIMITS.profile.preferences.each) },
  "profile.preference.remove": { path: /^\/profile\/preferences$/, mode: "auto", scope: "learner", minEvidence: 1, value: import_zod.z.string().min(1).max(import_constants.LIMITS.profile.preferences.each) },
  "profile.stuck_point.add": { path: /^\/profile\/stuck_points$/, mode: "auto", scope: "learner", minEvidence: 1, sources: ["distill", "reader"], value: staged(import_constants.LIMITS.profile.stuck_points.each) },
  "profile.stuck_point.resolve": { path: /^\/profile\/stuck_points$/, mode: "auto", scope: "learner", minEvidence: 1, value: staged(import_constants.LIMITS.profile.stuck_points.each) },
  "profile.misconception.add": { path: /^\/profile\/misconceptions$/, mode: "auto", scope: "learner", minEvidence: 1, value: staged(import_constants.LIMITS.profile.misconceptions.each) },
  "profile.effective_method.add": { path: /^\/profile\/effective_methods$/, mode: "auto", scope: "learner", minEvidence: 1, value: staged(import_constants.LIMITS.profile.effective_methods.each) },
  "distill.pitfall.add": { path: new RegExp(`^/distill/${STAGE_PATH}/pitfalls$`), mode: "pending", scope: "stage", minEvidence: 1, value: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.pitfalls.each) },
  "distill.must_memorize.add": { path: new RegExp(`^/distill/${STAGE_PATH}/must_memorize$`), mode: "pending", scope: "stage", minEvidence: 1, sources: ["distill", "reader"], value: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.must_memorize.each) },
  "distill.self_check.add": { path: new RegExp(`^/distill/${STAGE_PATH}/self_checks$`), mode: "pending", scope: "stage", minEvidence: 1, value: import_zod.z.object({ q: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.self_checks.q), a: import_zod.z.string().max(import_constants.LIMITS.distill.self_checks.a), kind: import_zod.z.enum(["calc", "concept", "debug"]), rubric: import_zod.z.string().max(import_constants.LIMITS.distill.self_checks.rubric).optional() }) },
  "distill.student_qa.add": { path: new RegExp(`^/distill/${STAGE_PATH}/student_qa$`), mode: "pending", scope: "stage", minEvidence: 1, value: import_zod.z.object({ q: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.student_qa.q), a: import_zod.z.string().max(import_constants.LIMITS.distill.student_qa.a), from_turn: import_zod.z.number().int().optional() }) },
  "distill.step.add": { path: new RegExp(`^/distill/${STAGE_PATH}/walkthrough$`), mode: "pending", scope: "stage", minEvidence: 1, value: import_zod.z.object({ say: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.walkthrough.say), ask: import_zod.z.string().max(import_constants.LIMITS.distill.walkthrough.ask).optional(), anchor: import_schema.AnchorSchema.optional() }) },
  "distill.method.replace": { path: new RegExp(`^/distill/${STAGE_PATH}/method$`), mode: "pending", scope: "stage", minEvidence: 2, value: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.method) },
  "card.style.adjust": { path: /^\/card\/(teaching_style|tone)$/, mode: "pending", scope: "teacher", minEvidence: 2, value: import_zod.z.string().min(1).max(import_constants.LIMITS.card.teaching_style) },
  "card.catchphrase.add": { path: /^\/card\/catchphrases$/, mode: "pending", scope: "teacher", minEvidence: 2, value: import_zod.z.string().min(1).max(import_constants.LIMITS.card.catchphrases.each) },
  "map.stage.propose": {
    path: /^\/map\/stages$/,
    mode: "pending",
    scope: "teacher",
    minEvidence: 0,
    source: "scan",
    value: import_zod.z.object({
      week: import_zod.z.union([import_zod.z.number().int(), import_zod.z.string().max(20)]),
      title: import_zod.z.string().min(1).max(import_constants.LIMITS.map.title),
      summary: import_zod.z.string().max(import_constants.LIMITS.map.summary).optional(),
      key_date: import_zod.z.string().max(import_constants.LIMITS.map.key_date).optional(),
      distill: import_zod.z.object({
        method: import_zod.z.string().max(import_constants.LIMITS.distill.method).optional(),
        // 1.1：讲解步与条目可带 quote（≤ 40 字、逐字抄自教材）；CLI / 服务端用查找把 quote 换成锚点，找不到就不带
        walkthrough: import_zod.z.array(import_zod.z.object({ say: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.walkthrough.say), ask: import_zod.z.string().max(import_constants.LIMITS.distill.walkthrough.ask).optional(), quote: import_zod.z.string().max(import_constants.LIMITS.distill.anchor_quote).optional(), anchor: import_schema.AnchorSchema.optional() })).max(import_constants.LIMITS.distill.walkthrough.count).optional(),
        must_memorize: import_zod.z.array(import_zod.z.union([import_zod.z.string().max(import_constants.LIMITS.distill.must_memorize.each), import_zod.z.object({ text: import_zod.z.string().max(import_constants.LIMITS.distill.must_memorize.each), quote: import_zod.z.string().max(import_constants.LIMITS.distill.anchor_quote).optional(), anchor: import_schema.AnchorSchema.optional() })])).max(import_constants.LIMITS.distill.must_memorize.count).optional(),
        self_checks: import_zod.z.array(import_zod.z.object({ q: import_zod.z.string().max(import_constants.LIMITS.distill.self_checks.q), a: import_zod.z.string().max(import_constants.LIMITS.distill.self_checks.a), kind: import_zod.z.enum(["calc", "concept", "debug"]) })).max(import_constants.LIMITS.distill.self_checks.count).optional(),
        pitfalls: import_zod.z.array(import_zod.z.union([import_zod.z.string().max(import_constants.LIMITS.distill.pitfalls.each), import_zod.z.object({ text: import_zod.z.string().max(import_constants.LIMITS.distill.pitfalls.each), quote: import_zod.z.string().max(import_constants.LIMITS.distill.anchor_quote).optional(), anchor: import_schema.AnchorSchema.optional() })])).max(import_constants.LIMITS.distill.pitfalls.count).optional()
      }).optional()
    })
  }
};
const FORBIDDEN_PATHS = [
  { re: /^\/card\/hard_rules/, why: "\u786C\u89C4\u5219\u53EA\u6709\u4F5C\u8005\u8868\u5355\u80FD\u6539 \u2014\u2014 \u6539\u4E86\u7B49\u4E8E\u628A\u8001\u5E08\u6539\u6210\u4F5C\u5F0A\u5DE5\u5177" },
  { re: /^\/map\/stages\/[^/]+\/status/, why: "\u9636\u6BB5\u72B6\u6001\u53EA\u7531\u81EA\u68C0\u95E8\u7981\u5F15\u64CE\u5199\uFF0CLLM \u7684\u4EFB\u4F55 op \u90FD\u5199\u4E0D\u5230\u5B83" },
  { re: /^\/profile\/mastery/, why: "\u638C\u63E1\u5EA6\u53EA\u7531\u81EA\u68C0\u95E8\u7981\u5F15\u64CE\u5199" },
  { re: /^\/(policy|license|aigc|checksum|format|id|version|author|audience)(\/|$)/, why: "frontmatter \u53EA\u7531\u4F5C\u8005\u8868\u5355 / \u670D\u52A1\u7AEF\u5199" }
];
const MAX_OPS_PER_BATCH = 20;
const sourcesOf = (spec) => spec.sources || [spec.source || "distill"];
const SOURCE_LABELS = { distill: "\u84B8\u998F", scan: "\u626B\u63CF\u76EE\u5F55", reader: "\u9605\u8BFB\u9762\uFF08\u5B66\u751F\u4EB2\u624B\u70B9\u7684\uFF09" };
function catalogForPrompt(source = "distill") {
  return Object.entries(OP_CATALOG).filter(([, spec]) => sourcesOf(spec).includes(source)).map(([op, spec]) => `- ${op}  path \u5F62\u5982 ${spec.path.source.replace(/\\\//g, "/").replace(/^\^|\$$/g, "").replace(/\(stage-\\d\{2,3\}\)/g, "<stage_id>").replace(/\(teaching_style\|tone\)/g, "<teaching_style|tone>")}  ${spec.mode === "auto" ? "\u81EA\u52A8\u751F\u6548" : "\u9700\u4F5C\u8005\u786E\u8BA4"}${spec.minEvidence ? `  evidence \u2265 ${spec.minEvidence}` : ""}`).join("\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AnchorSchema,
  FORBIDDEN_PATHS,
  MAX_OPS_PER_BATCH,
  OP_CATALOG,
  SOURCE_LABELS,
  catalogForPrompt,
  sourcesOf
});
