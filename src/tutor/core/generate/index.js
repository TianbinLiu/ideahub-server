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
var generate_exports = {};
__export(generate_exports, {
  CHUNK_MAX: () => import_sections.CHUNK_MAX,
  CardReplySchema: () => import_schemas.CardReplySchema,
  DEFAULT_PRODUCER: () => import_assemble.DEFAULT_PRODUCER,
  MAX_TOKENS: () => import_pipeline.MAX_TOKENS,
  PRICES: () => import_pricing.PRICES,
  SECTION_HEAD_RE: () => import_sections.SECTION_HEAD_RE,
  STAGE_INPUT_CHARS: () => import_pipeline.STAGE_INPUT_CHARS,
  STYLE_PRESETS: () => import_demo.STYLE_PRESETS,
  StageReplySchema: () => import_schemas.StageReplySchema,
  StagesReplySchema: () => import_schemas.StagesReplySchema,
  anchorDistill: () => import_pipeline.anchorDistill,
  assembleDoc: () => import_assemble.assembleDoc,
  chunksOf: () => import_sections.chunksOf,
  demoCard: () => import_demo.demoCard,
  demoDistill: () => import_demo.demoDistill,
  demoGuide: () => import_demo.demoGuide,
  demoStages: () => import_demo.demoStages,
  generateQuote: () => import_pricing.generateQuote,
  hardRulesFrom: () => import_demo.hardRulesFrom,
  licenseSourceOf: () => import_assemble.licenseSourceOf,
  newDocId: () => import_assemble.newDocId,
  outlineOf: () => import_sections.outlineOf,
  planGenerate: () => import_pipeline.planGenerate,
  presetOf: () => import_demo.presetOf,
  proposeStages: () => import_pipeline.proposeStages,
  realNameHint: () => import_demo.realNameHint,
  runGenerate: () => import_pipeline.runGenerate,
  sectionText: () => import_sections.sectionText,
  sectionsOf: () => import_sections.sectionsOf,
  seedDoc: () => import_assemble.seedDoc
});
module.exports = __toCommonJS(generate_exports);
var import_pipeline = require("./pipeline.js");
var import_sections = require("./sections.js");
var import_assemble = require("./assemble.js");
var import_pricing = require("./pricing.js");
var import_demo = require("./demo.js");
var import_schemas = require("./schemas.js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHUNK_MAX,
  CardReplySchema,
  DEFAULT_PRODUCER,
  MAX_TOKENS,
  PRICES,
  SECTION_HEAD_RE,
  STAGE_INPUT_CHARS,
  STYLE_PRESETS,
  StageReplySchema,
  StagesReplySchema,
  anchorDistill,
  assembleDoc,
  chunksOf,
  demoCard,
  demoDistill,
  demoGuide,
  demoStages,
  generateQuote,
  hardRulesFrom,
  licenseSourceOf,
  newDocId,
  outlineOf,
  planGenerate,
  presetOf,
  proposeStages,
  realNameHint,
  runGenerate,
  sectionText,
  sectionsOf,
  seedDoc
});
