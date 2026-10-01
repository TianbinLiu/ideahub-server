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
var anchors_exports = {};
__export(anchors_exports, {
  PAGE_BREAK: () => import_blocks.PAGE_BREAK,
  locateQuote: () => locateQuote,
  locateQuoteInPages: () => locateQuoteInPages,
  resolveProposalAnchors: () => resolveProposalAnchors
});
module.exports = __toCommonJS(anchors_exports);
var import_constants = require("../format/constants.js");
var import_normalize = require("../format/normalize.js");
var import_blocks = require("./blocks.js");
function locateQuote(text, quote, materialSha) {
  if (!quote || typeof quote !== "string") return null;
  const q = (0, import_blocks.fold)(quote);
  if (q.length === 0 || quote.length > import_constants.LIMITS.distill.anchor_quote) return null;
  const src = (0, import_normalize.normalizeText)(text);
  const map = [];
  let folded = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) continue;
    map.push(i);
    folded += ch;
  }
  const at = folded.indexOf(q);
  if (at < 0) return null;
  const origIdx = map[at];
  const page = (src.slice(0, origIdx).match(/\f/g) || []).length + 1;
  return { material: (0, import_blocks.shortSha)(materialSha), page, quote: quote.trim() };
}
function locateQuoteInPages(pages, quote, materialSha) {
  if (!quote || typeof quote !== "string" || !Array.isArray(pages)) return null;
  const q = (0, import_blocks.fold)(quote);
  if (q.length === 0 || quote.length > import_constants.LIMITS.distill.anchor_quote) return null;
  for (const p of pages) {
    for (const b of p.blocks || []) {
      const at = (0, import_blocks.fold)(b.text).indexOf(q);
      if (at >= 0) {
        const a = { material: (0, import_blocks.shortSha)(materialSha), page: p.idx, quote: quote.trim() };
        if (b.hash) {
          a.chunk = b.hash;
          a.start = at;
          a.end = at + q.length;
        }
        return a;
      }
    }
  }
  for (const p of pages) {
    if ((0, import_blocks.fold)((p.blocks || []).map((b) => b.text).join("\n")).includes(q)) return { material: (0, import_blocks.shortSha)(materialSha), page: p.idx, quote: quote.trim() };
  }
  return null;
}
function resolveProposalAnchors(value, material, materialSha) {
  const dropped = [];
  const pages = material && typeof material === "object" && Array.isArray(material.pages) ? material.pages : null;
  const text = typeof material === "string" ? material : material?.text ?? "";
  const toAnchor = (q, where) => {
    if (!q) return void 0;
    const a = pages ? locateQuoteInPages(pages, q, materialSha) : locateQuote(text, q, materialSha);
    if (!a) dropped.push(`${where}\uFF1A\u77ED\u5F15\u300C${q}\u300D\u5728\u6559\u6750\u91CC\u627E\u4E0D\u5230\uFF0C\u8FD9\u4E00\u6761\u4E0D\u5E26\u951A\u70B9`);
    return a || void 0;
  };
  const d = value.distill;
  if (!d) return { value, dropped };
  const out = { ...value, distill: { ...d } };
  if (Array.isArray(d.walkthrough)) {
    out.distill.walkthrough = d.walkthrough.map((w, i) => {
      const { quote, ...rest } = w;
      const anchor = toAnchor(quote, `\u8BB2\u89E3\u6B65 #${i + 1}`);
      return anchor ? { ...rest, anchor } : rest;
    });
  }
  for (const key of ["must_memorize", "pitfalls"]) {
    if (!Array.isArray(d[key])) continue;
    out.distill[key] = d[key].map((x, i) => {
      if (typeof x === "string") return x;
      const anchor = toAnchor(x.quote, `${key} #${i + 1}`);
      return anchor ? { text: x.text, anchor } : x.text;
    });
  }
  return { value: out, dropped };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PAGE_BREAK,
  locateQuote,
  locateQuoteInPages,
  resolveProposalAnchors
});
