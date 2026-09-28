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
  expectedProduceId: () => expectedProduceId,
  validateTutorDoc: () => validateTutorDoc
});
module.exports = __toCommonJS(validate_exports);
var import_schema = require("./schema.js");
var import_constants = require("./constants.js");
var import_uuid5 = require("./uuid5.js");
function validateTutorDoc(doc, meta = {}) {
  const errors = [];
  const warnings = [];
  const shape = import_schema.TutorDocSchema.safeParse(doc);
  if (!shape.success) errors.push(...(0, import_schema.issuesToLines)(shape.error.issues).map((l) => `\u5F62\u72B6\uFF1A${l}`));
  if (typeof doc.stages === "number" && doc.stages !== doc.map.stages.length) {
    errors.push(`frontmatter \u7684 stages=${doc.stages}\uFF0C\u4F46 \u2462 \u91CC\u6709 ${doc.map.stages.length} \u4E2A\u9636\u6BB5\uFF08\u8BA1\u6570\u5BF9\u4E0D\u4E0A\uFF09`);
  }
  const ids = doc.map.stages.map((s) => s.stage_id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) errors.push(`\u2462 \u91CC stage_id \u91CD\u590D\uFF1A${[...new Set(dup)].join("\u3001")}`);
  for (const id of Object.keys(doc.distill)) {
    if (!ids.includes(id)) errors.push(`\u2463 \u91CC\u6709 ${id}\uFF0C\u2462 \u8BFE\u7A0B\u5730\u56FE\u91CC\u6CA1\u6709\u8FD9\u4E2A\u9636\u6BB5\uFF08\u6574\u53E5\u62D2\uFF09`);
  }
  for (const id of ids) {
    if (!doc.distill[id]) warnings.push(`\u2462 \u91CC\u7684 ${id} \u5728 \u2463 \u91CC\u8FD8\u6CA1\u6709\u5185\u5BB9\uFF08\u8FD8\u6CA1\u8BB2\u5230\uFF1F\uFF09`);
  }
  const locked = doc.card.hard_rules.filter((r) => r.locked);
  const ai = doc.policy?.ai;
  if ((ai === "prohibited" || ai === "limited") && locked.length === 0) {
    errors.push(`policy.ai=${ai}\uFF0C\u2460 \u786C\u89C4\u5219\u91CC\u5374\u4E00\u6761 \u{1F512} \u90FD\u6CA1\u6709\uFF08\u8BFE\u7A0B AI \u653F\u7B56\u5FC5\u987B\u6D3E\u751F\u51FA\u81F3\u5C11\u4E00\u6761\u9501\u5B9A\u89C4\u5219\uFF09`);
  }
  for (const r of doc.card.hard_rules) {
    if (r.from === "policy" && !r.locked) errors.push(`\u786C\u89C4\u5219\u300C${r.text.slice(0, 30)}\u2026\u300Dfrom=policy \u5374\u6CA1\u9501\uFF08from=policy \u7684 locked \u6052 true\uFF09`);
  }
  if (doc.policy?.homework_mode === "principles_only" && !locked.some((r) => /原理|principle/i.test(r.text))) {
    warnings.push("homework_mode=principles_only\uFF0C\u4F46 \u{1F512} \u89C4\u5219\u91CC\u6CA1\u6709\u4E00\u6761\u63D0\u5230\u300C\u53EA\u8BB2\u539F\u7406\u300D\u2014\u2014 \u5EFA\u8BAE\u8865\u4E00\u6761\u4E0E\u653F\u7B56\u9010\u5B57\u5BF9\u5E94\u7684");
  }
  if (doc.audience === "market") {
    const real = doc.map.stages.filter((s) => s.status !== "\u672A\u8BB2");
    if (real.length) warnings.push(`\u53D1\u5E03\u4EF6\u91CC ${real.length} \u4E2A\u9636\u6BB5\u5E26\u7740\u771F\u5B9E\u72B6\u6001\uFF08${real.slice(0, 3).map((s) => s.stage_id).join("\u3001")}\u2026\uFF09\uFF0C\u5BFC\u5165\u65F6\u4E00\u5F8B\u6309\u300C\u672A\u8BB2\u300D\u843D`);
    if (doc.includes_student_profile === "full") errors.push("\u53D1\u5E03\u4EF6\uFF08audience=market\uFF09\u4E0D\u5141\u8BB8 includes_student_profile=full");
    if (doc.includes_dialogue_log === "full") errors.push("\u53D1\u5E03\u4EF6\uFF08audience=market\uFF09\u4E0D\u5141\u8BB8 includes_dialogue_log=full");
    if (doc.profile.stuck_points.some((x) => x.evidence?.length || x.first_seen || x.last_seen)) {
      errors.push("\u53D1\u5E03\u4EF6\u91CC \u2461 \u5361\u70B9\u5E26\u7740 evidence / \u65F6\u95F4\uFF08\xA78\uFF1A\u8FD9\u4E9B\u6C38\u4E0D\u968F\u4EBA\u683C\u53D1\u5E03\uFF09");
    }
    if (doc.profile.mastery) errors.push("\u53D1\u5E03\u4EF6\u91CC \u2461 \u5E26\u7740 mastery\uFF08\xA78\uFF1A\u6C38\u4E0D\u5E26\uFF09");
  }
  if (doc.license?.source === "unsure" && doc.audience === "market") errors.push("license.source=unsure \u7684\u4EBA\u683C\u4E0D\u80FD\u53D1\u5E03\uFF08\xA73\uFF09");
  if (meta.requireLabels !== false && meta.labels) {
    if (!meta.labels.head) errors.push("\u6B63\u6587\u7B2C\u4E00\u884C\u7F3A\u663E\u5F0F AIGC \u6807\u8BC6\uFF08> \u672C\u6587\u4EF6\u4E3A\u4EBA\u5DE5\u667A\u80FD\u751F\u6210\u5408\u6210\u5185\u5BB9\u2026\uFF09");
    if (!meta.labels.tail) errors.push("\u6B63\u6587\u6700\u540E\u4E00\u884C\u7F3A\u663E\u5F0F AIGC \u6807\u8BC6");
    for (const [where, line] of [["\u9996\u884C", meta.labels.head], ["\u672B\u884C", meta.labels.tail]]) {
      const mm = line && import_constants.EXPLICIT_LABEL_RE.exec(line);
      if (mm && (mm[2] !== doc.id || Number(mm[3]) !== doc.version)) {
        errors.push(`${where}\u663E\u5F0F\u6807\u8BC6\u5199\u7684\u662F ${mm[2]} v${mm[3]}\uFF0C\u4E0E frontmatter \u7684 ${doc.id} v${doc.version} \u4E0D\u4E00\u81F4`);
      }
    }
  }
  if (doc.AIGC) {
    const expect = expectedProduceId(doc);
    if (doc.AIGC.ProduceID !== expect) errors.push(`AIGC.ProduceID \u5E94\u4E3A ${expect}\uFF08\u4ECE ${(0, import_constants.contentIdOf)(doc)} \u6D3E\u751F\u7684 UUID v5\uFF09\uFF0C\u5B9E\u9645\u662F ${doc.AIGC.ProduceID}`);
    if (doc.AIGC.Label !== import_constants.AIGC_LABEL_GENERATED) warnings.push(`AIGC.Label=${doc.AIGC.Label}\uFF081 = \u5C5E\u4E8E AI \u751F\u6210\u5408\u6210\uFF1B\u672C\u4EA7\u54C1\u5BFC\u51FA\u7684\u4E00\u5F8B\u662F 1\uFF09`);
  }
  if (meta.computedChecksum) {
    if (!doc.checksum) warnings.push("frontmatter \u6CA1\u6709 checksum\uFF08\u5BFC\u51FA\u4EF6\u5FC5\u987B\u6709\uFF1B\u8349\u7A3F\u53EF\u4EE5\u6CA1\u6709\uFF09");
    else if (doc.checksum !== meta.computedChecksum) errors.push(`checksum \u5BF9\u4E0D\u4E0A\uFF1A\u6587\u4EF6\u91CC\u5199 ${doc.checksum.slice(0, 20)}\u2026\uFF0C\u6B63\u6587\u7B97\u51FA ${meta.computedChecksum.slice(0, 20)}\u2026\uFF08\u6B63\u6587\u88AB\u6539\u8FC7\u6216\u6807\u8BC6\u884C\u88AB\u5220\u8FC7\uFF09`);
  }
  const materials = new Set(doc.map.source_material_hashes?.map((h) => h.replace(/^sha256:/, "").slice(0, 12)) || []);
  for (const [id, st] of Object.entries(doc.distill)) {
    const anchors = [...st.walkthrough || [], ...st.must_memorize, ...st.pitfalls, ...st.self_checks, ...st.student_qa].map((x) => x && typeof x === "object" ? x.anchor : void 0).filter(Boolean);
    for (const a of anchors) {
      if (materials.size && !materials.has(a.material)) warnings.push(`\u2463 ${id} \u6709\u951A\u70B9\u6307\u5411\u6559\u6750 m:${a.material}\uFF0C\u4F46 \u2462 \u7684\u6559\u6750\u6307\u7EB9\u91CC\u6CA1\u6709\u5B83\uFF08\u4E0B\u8F7D\u8005\u5BF9\u4E0D\u4E0A\u65F6\u4F1A\u9000\u5316\u6210\u9636\u6BB5\u7EA7\u6761\u76EE\uFF09`);
    }
    if (st.walkthrough?.length && !st.walkthrough.some((w) => w.anchor)) warnings.push(`\u2463 ${id} \u7684\u8BB2\u89E3\u6B65\u4E00\u6761\u90FD\u6CA1\u6709\u951A\u70B9 \u2014\u2014 \u5BFC\u5B66\u6F2B\u6E38\u4F1A\u9000\u5316\u6210\u53EA\u5728\u8001\u5E08\u9762\u677F\u91CC\u5FF5`);
  }
  const textOf = (x) => typeof x === "string" ? x : x.text;
  for (const [id, st] of Object.entries(doc.distill)) {
    const chars = [st.method, ...(st.walkthrough || []).map((w) => w.say), ...st.must_memorize.map(textOf), ...st.self_checks.flatMap((q) => [q.q, q.a]), ...st.student_qa.flatMap((q) => [q.q, q.a]), ...st.pitfalls.map(textOf)].join("").length;
    if (chars > import_constants.LIMITS.distill.per_stage_chars.max) warnings.push(`\u2463 ${id} \u5408\u8BA1 ${chars} \u5B57\uFF0C\u8D85\u8FC7\u5EFA\u8BAE\u503C ${import_constants.LIMITS.distill.per_stage_chars.max}\uFF08\u4E00\u6B21\u4E00\u9636\u6BB5\u8981\u6574\u6BB5\u8FDB\u4E0A\u4E0B\u6587\uFF09`);
    if (doc.audience === "market") {
      if (!st.method) warnings.push(`\u2463 ${id} \u7F3A\u300C\u8001\u5E08\u7684\u8BB2\u6CD5\u300D`);
      if (st.must_memorize.length < 1) warnings.push(`\u2463 ${id} \u7F3A\u300C\u5FC5\u80CC\u300D\uFF08\u53D1\u5E03\u4EF6\u6BCF\u4E2A\u5DF2\u8BB2\u9636\u6BB5\u8981\u6709\uFF09`);
      if (st.self_checks.length < import_constants.LIMITS.distill.self_checks.min_for_market) warnings.push(`\u2463 ${id} \u81EA\u68C0\u9898\u4E0D\u8DB3 ${import_constants.LIMITS.distill.self_checks.min_for_market} \u9053\uFF08\u2462\u300C\u5B66\u751F\u5DF2\u901A\u8FC7\u300D\u7684\u5224\u636E\u53EA\u770B\u5B83\uFF09`);
    }
  }
  return { errors, warnings, ok: errors.length === 0 };
}
function expectedProduceId(doc) {
  return (0, import_uuid5.uuidv5)(import_constants.PRODUCE_ID_NAMESPACE, (0, import_constants.contentIdOf)(doc));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  expectedProduceId,
  validateTutorDoc
});
