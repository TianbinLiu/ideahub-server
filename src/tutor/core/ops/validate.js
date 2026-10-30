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
var validate_exports = {};
__export(validate_exports, {
  validateOpsBatch: () => validateOpsBatch
});
module.exports = __toCommonJS(validate_exports);
var import_zod = require("zod");
var import_checksum = require("../format/checksum.js");
var import_catalog = require("./catalog.js");
var import_scrubPii = require("./scrubPii.js");
const OpShape = import_zod.z.object({
  op: import_zod.z.string(),
  path: import_zod.z.string(),
  value: import_zod.z.unknown(),
  evidence: import_zod.z.array(import_zod.z.number().int().min(0)).optional(),
  rationale: import_zod.z.string().max(500).optional(),
  anchor: import_catalog.AnchorSchema.optional()
  // 1.1：教材上的一处（学生圈选 / 老师钉子），落到条目上
});
function validateOpsBatch(ops, ctx) {
  const errors = [];
  if (!Array.isArray(ops)) return { ok: false, errors: ['ops \u5FC5\u987B\u662F\u6570\u7EC4\uFF08\u6A21\u578B\u6CA1\u6709\u6309 { "ops": [...] } \u7684\u5F62\u72B6\u56DE\u7B54\uFF09'], ops: [] };
  if (ops.length === 0) return { ok: true, errors: [], ops: [] };
  if (ops.length > import_catalog.MAX_OPS_PER_BATCH) errors.push(`\u4E00\u6279\u6700\u591A ${import_catalog.MAX_OPS_PER_BATCH} \u6761 op\uFF0C\u8FD9\u6279\u6709 ${ops.length} \u6761`);
  const source = ctx.source || "distill";
  const out = [];
  ops.forEach((raw, i) => {
    const where = `\u7B2C ${i + 1} \u6761`;
    const shape = OpShape.safeParse(raw);
    if (!shape.success) {
      errors.push(`${where}\uFF1A\u5F62\u72B6\u4E0D\u5BF9\uFF08${shape.error.issues.map((x) => `${x.path.join(".")}\uFF1A${x.message}`).join("\uFF1B")}\uFF09`);
      return;
    }
    const op = shape.data;
    const forbidden = import_catalog.FORBIDDEN_PATHS.find((f) => f.re.test(op.path));
    if (forbidden) {
      errors.push(`${where}\uFF08op=${op.op}\uFF09\u7684 path\u300C${op.path}\u300D\u5728\u7981\u5199\u540D\u5355\uFF1A${forbidden.why}`);
      return;
    }
    const spec = import_catalog.OP_CATALOG[op.op];
    if (!spec) {
      errors.push(`${where}\uFF1A\u4E0D\u8BA4\u8BC6\u7684 op\u300C${op.op}\u300D\uFF08\u76EE\u5F55\u89C1 docs/03 \xA77.3\uFF09`);
      return;
    }
    if (!(0, import_catalog.sourcesOf)(spec).includes(source)) {
      errors.push(`${where}\uFF1Aop\u300C${op.op}\u300D\u53EA\u80FD\u6765\u81EA\u300C${(0, import_catalog.sourcesOf)(spec).map((s) => import_catalog.SOURCE_LABELS[s] || s).join(" / ")}\u300D\u8FD9\u6761\u8DEF\uFF0C\u8FD9\u6279\u6765\u81EA\u300C${import_catalog.SOURCE_LABELS[source] || source}\u300D`);
      return;
    }
    if (!spec.path.test(op.path)) {
      errors.push(`${where}\uFF1Aop\u300C${op.op}\u300D\u7684 path \u5E94\u5F62\u5982 ${spec.path.source}\uFF0C\u7ED9\u7684\u662F\u300C${op.path}\u300D`);
      return;
    }
    const ev = op.evidence || [];
    if (ev.length < spec.minEvidence) {
      errors.push(`${where}\uFF1Aop\u300C${op.op}\u300D\u8981 \u2265 ${spec.minEvidence} \u6761 evidence\uFF08turn seq\uFF09\uFF0C\u7ED9\u4E86 ${ev.length} \u6761`);
      return;
    }
    const val = spec.value.safeParse(op.value);
    if (!val.success) {
      errors.push(`${where}\uFF1Aop\u300C${op.op}\u300D\u7684 value \u4E0D\u5408\u5F62\u72B6\uFF08${val.error.issues.map((x) => `${x.path.join(".") || "value"}\uFF1A${x.message}`).join("\uFF1B")}\uFF09`);
      return;
    }
    if (ctx.doc && spec.scope === "stage") {
      const stage = spec.path.exec(op.path)[1];
      if (!ctx.doc.map.stages.some((s) => s.stage_id === stage)) {
        errors.push(`${where}\uFF1Aop\u300C${op.op}\u300D\u6307\u5411\u7684 ${stage} \u4E0D\u5728 \u2462 \u8BFE\u7A0B\u5730\u56FE\u91CC`);
        return;
      }
    }
    const hits = [];
    const value = (0, import_scrubPii.scrubDeep)(val.data, hits);
    out.push({
      ...op,
      value,
      evidence: ev,
      mode: spec.mode,
      // opId = sha256(runId + turn_from + turn_to + index)：重放同一批 ops 幂等（docs/03 §7.3）
      opId: (0, import_checksum.sha256Hex)(`${ctx.runId}:${ctx.turnFrom ?? ""}:${ctx.turnTo ?? ""}:${i}`),
      piiScrubbed: hits.length ? hits : void 0
    });
  });
  if (errors.length) return { ok: false, errors, ops: [] };
  return { ok: true, errors: [], ops: out };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  validateOpsBatch
});
