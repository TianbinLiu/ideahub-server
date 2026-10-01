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
var policy_exports = {};
__export(policy_exports, {
  HOMEWORK_RE: () => HOMEWORK_RE,
  NEAR_DAYS: () => NEAR_DAYS,
  policyGate: () => policyGate
});
module.exports = __toCommonJS(policy_exports);
const HOMEWORK_RE = /作业|习题|assignment|homework|problem\s*set|实验报告|lab\s*report|考试|期中|期末|exam|quiz|测验|帮我做|代做|写出答案|完整答案|给我答案|直接给答案|标准答案|把答案/i;
const NEAR_DAYS = 7;
function policyGate(doc, text, now = /* @__PURE__ */ new Date()) {
  const mode = doc.policy?.homework_mode ?? "principles_only";
  const hit = HOMEWORK_RE.test(String(text ?? ""));
  const near = (doc.map?.key_dates || []).filter((d) => /homework|exam/.test(d.kind || "") && daysUntil(d.at, now) !== null && daysUntil(d.at, now) <= NEAR_DAYS && daysUntil(d.at, now) >= -1);
  const nearAsk = near.length > 0 && /题|答案|做|解/.test(String(text ?? ""));
  const blocked = mode === "principles_only" && (hit || nearAsk);
  return { blocked, homeworkDetected: hit || nearAsk, keyDate: near[0] ?? null, mode, policyText: doc.policy?.text ?? "" };
}
function daysUntil(at, now) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(at ?? ""));
  if (!m) return null;
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((d - n) / 864e5);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOMEWORK_RE,
  NEAR_DAYS,
  policyGate
});
