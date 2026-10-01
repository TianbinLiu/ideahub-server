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
var pricing_exports = {};
__export(pricing_exports, {
  PRICES: () => PRICES,
  generateQuote: () => generateQuote
});
module.exports = __toCommonJS(pricing_exports);
const PRICES = { tutor_extract: 400, tutor_distill: 600, tutor_turn: 400 };
function generateQuote({ materials, stages, demo = false }) {
  const lines = [
    { kind: "tutor_extract", n: Math.max(0, materials), why: "\u9636\u6BB5\u63D0\u8BAE\uFF08\u6BCF\u4EFD\u6559\u6750\u4E00\u7B14\uFF09" },
    { kind: "tutor_extract", n: Math.max(0, stages), why: "\u9010\u9636\u6BB5\u84B8\u998F\uFF08\u6BCF\u9636\u6BB5\u4E00\u7B14\uFF09" },
    { kind: "tutor_extract", n: 1, why: "\u2460 \u4EBA\u683C\u5361 + \u2465 \u590D\u523B\u6307\u5357" }
  ].map((l) => ({ ...l, each: PRICES[l.kind], tokens: PRICES[l.kind] * l.n }));
  return { lines, total: demo ? 0 : lines.reduce((s, l) => s + l.tokens, 0), demo, suggested: true };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PRICES,
  generateQuote
});
