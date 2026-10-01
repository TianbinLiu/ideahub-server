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
var schemas_exports = {};
__export(schemas_exports, {
  CardReplySchema: () => CardReplySchema,
  StageReplySchema: () => StageReplySchema,
  StagesReplySchema: () => StagesReplySchema
});
module.exports = __toCommonJS(schemas_exports);
var import_zod = require("zod");
var import_constants = require("../format/constants.js");
var import_schema = require("../format/schema.js");
const str = (max) => import_zod.z.string().max(max);
const quoted = (max) => import_zod.z.union([import_zod.z.string().min(1).max(max), import_zod.z.object({ text: import_zod.z.string().min(1).max(max), quote: import_zod.z.string().max(import_constants.LIMITS.distill.anchor_quote).optional() })]);
const StagesReplySchema = import_zod.z.object({
  stages: import_zod.z.array(import_zod.z.object({
    week: import_zod.z.union([import_zod.z.number().int().min(0).max(99), import_zod.z.string().max(10)]).optional(),
    title: import_zod.z.string().min(1).max(import_constants.LIMITS.map.title),
    summary: str(import_constants.LIMITS.map.summary).optional(),
    sections: import_zod.z.array(import_zod.z.number().int().min(1)).min(1)
  })).min(1).max(import_constants.LIMITS.map.stages)
});
const StageReplySchema = import_zod.z.object({
  method: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.method),
  walkthrough: import_zod.z.array(import_zod.z.object({
    say: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.walkthrough.say),
    ask: str(import_constants.LIMITS.distill.walkthrough.ask).optional(),
    quote: str(import_constants.LIMITS.distill.anchor_quote).optional()
  })).max(import_constants.LIMITS.distill.walkthrough.count).optional(),
  must_memorize: import_zod.z.array(quoted(import_constants.LIMITS.distill.must_memorize.each)).min(1).max(import_constants.LIMITS.distill.must_memorize.count),
  self_checks: import_zod.z.array(import_zod.z.object({ q: import_zod.z.string().min(1).max(import_constants.LIMITS.distill.self_checks.q), a: str(import_constants.LIMITS.distill.self_checks.a), kind: import_zod.z.enum(["calc", "concept", "debug"]) })).min(import_constants.LIMITS.distill.self_checks.min_for_market).max(import_constants.LIMITS.distill.self_checks.count),
  pitfalls: import_zod.z.array(quoted(import_constants.LIMITS.distill.pitfalls.each)).max(import_constants.LIMITS.distill.pitfalls.count).optional()
});
const CardReplySchema = import_zod.z.object({
  card: import_schema.CardSchema.omit({ hard_rules: true, example_turns: true }).extend({
    example_turns: import_schema.CardSchema.shape.example_turns.optional(),
    extra_rules: import_zod.z.array(import_zod.z.string().min(1).max(import_constants.LIMITS.card.hard_rules.each)).max(6).optional()
  }),
  guide: import_schema.GuideSchema
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CardReplySchema,
  StageReplySchema,
  StagesReplySchema
});
