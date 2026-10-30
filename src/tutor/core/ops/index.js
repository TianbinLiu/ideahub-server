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
var ops_exports = {};
__export(ops_exports, {
  FORBIDDEN_PATHS: () => import_catalog.FORBIDDEN_PATHS,
  MAX_OPS_PER_BATCH: () => import_catalog.MAX_OPS_PER_BATCH,
  OP_CATALOG: () => import_catalog.OP_CATALOG,
  PII_MASK: () => import_scrubPii.PII_MASK,
  REVISION_KINDS: () => import_revision.REVISION_KINDS,
  appendRevision: () => import_revision.appendRevision,
  appliedOpIds: () => import_revision.appliedOpIds,
  applyOne: () => import_apply.applyOne,
  applyOps: () => import_apply.applyOps,
  catalogForPrompt: () => import_catalog.catalogForPrompt,
  isNonPersonalIp: () => import_scrubPii.isNonPersonalIp,
  pendingOps: () => import_revision.pendingOps,
  readRevisions: () => import_revision.readRevisions,
  revertOne: () => import_apply.revertOne,
  revertOps: () => import_revision.revertOps,
  revertRevision: () => import_revision.revertRevision,
  reviewRevision: () => import_revision.reviewRevision,
  scrubDeep: () => import_scrubPii.scrubDeep,
  scrubPii: () => import_scrubPii.scrubPii,
  summarize: () => import_revision.summarize,
  validateOpsBatch: () => import_validate.validateOpsBatch
});
module.exports = __toCommonJS(ops_exports);
var import_catalog = require("./catalog.js");
var import_validate = require("./validate.js");
var import_apply = require("./apply.js");
var import_revision = require("./revision.js");
var import_scrubPii = require("./scrubPii.js");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FORBIDDEN_PATHS,
  MAX_OPS_PER_BATCH,
  OP_CATALOG,
  PII_MASK,
  REVISION_KINDS,
  appendRevision,
  appliedOpIds,
  applyOne,
  applyOps,
  catalogForPrompt,
  isNonPersonalIp,
  pendingOps,
  readRevisions,
  revertOne,
  revertOps,
  revertRevision,
  reviewRevision,
  scrubDeep,
  scrubPii,
  summarize,
  validateOpsBatch
});
