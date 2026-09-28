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
var context_exports = {};
__export(context_exports, {
  CONTEXT_MAX: () => CONTEXT_MAX,
  PAGE_REF_RE: () => PAGE_REF_RE,
  pageRefs: () => pageRefs,
  selectionContext: () => selectionContext
});
module.exports = __toCommonJS(context_exports);
var import_blocks = require("../materials/blocks.js");
const CONTEXT_MAX = 1500;
function selectionContext(pages, anchor, { around = 1, max = CONTEXT_MAX } = {}) {
  if (!anchor || !Array.isArray(pages)) return "";
  const page = pages.find((p) => p.idx === anchor.page);
  if (!page) return "";
  let i = anchor.chunk ? page.blocks.findIndex((b) => b.hash === anchor.chunk) : -1;
  if (i < 0 && anchor.quote) {
    const q = (0, import_blocks.fold)(anchor.quote);
    i = page.blocks.findIndex((b) => (0, import_blocks.fold)(b.text).includes(q));
  }
  const blocks = i < 0 ? page.blocks : page.blocks.slice(Math.max(0, i - around), i + around + 1);
  return blocks.map((b) => b.text).join("\n\n").slice(0, max);
}
const PAGE_REF_RE = /\[\[p(\d+)\]\]/g;
const pageRefs = (text) => [...String(text ?? "").matchAll(PAGE_REF_RE)].map((m) => Number(m[1]));
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONTEXT_MAX,
  PAGE_REF_RE,
  pageRefs,
  selectionContext
});
