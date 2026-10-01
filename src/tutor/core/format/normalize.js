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
var normalize_exports = {};
__export(normalize_exports, {
  canonicalBody: () => canonicalBody,
  normalizeText: () => normalizeText
});
module.exports = __toCommonJS(normalize_exports);
function normalizeText(text) {
  if (typeof text !== "string") throw new TypeError("normalizeText: \u53EA\u6536\u5B57\u7B26\u4E32");
  let t = text;
  if (t.charCodeAt(0) === 65279) t = t.slice(1);
  t = t.replace(/\r\n?/g, "\n");
  return t.normalize("NFC");
}
function canonicalBody(body) {
  return normalizeText(body).replace(/[ \t]+$/gm, "").replace(/\n*$/, "") + "\n";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  canonicalBody,
  normalizeText
});
