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
var pptxXml_exports = {};
__export(pptxXml_exports, {
  decodeXml: () => decodeXml,
  slideBlocksFromXml: () => slideBlocksFromXml,
  slideFileOrder: () => slideFileOrder
});
module.exports = __toCommonJS(pptxXml_exports);
function slideFileOrder(names) {
  return names.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]));
}
function slideBlocksFromXml(xml) {
  const blocks = [];
  let title;
  for (const sp of String(xml).split(/<p:sp[ >]/).slice(1)) {
    const isTitle = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(sp.split("</p:nvSpPr>")[0] || "");
    const paras = [];
    for (const p of sp.split(/<a:p[ >]/).slice(1)) {
      const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]));
      const text = runs.join("").trim();
      if (text) paras.push(text);
    }
    if (!paras.length) continue;
    if (isTitle && !title) {
      title = paras.join(" ");
      blocks.push({ text: title });
    } else for (const t of paras) blocks.push({ text: t });
  }
  return title ? { title, blocks } : { blocks };
}
function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decodeXml,
  slideBlocksFromXml,
  slideFileOrder
});
