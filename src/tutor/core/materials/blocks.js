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
var blocks_exports = {};
__export(blocks_exports, {
  HASH_LEN: () => HASH_LEN,
  PAGE_BREAK: () => PAGE_BREAK,
  blockHash: () => blockHash,
  blocksFromPdfItems: () => blocksFromPdfItems,
  findQuote: () => findQuote,
  fold: () => fold,
  hashPages: () => hashPages,
  pagesToText: () => pagesToText,
  paragraphsToBlocks: () => paragraphsToBlocks,
  sha256Hex: () => sha256Hex,
  shortSha: () => shortSha,
  titleOf: () => titleOf
});
module.exports = __toCommonJS(blocks_exports);
var import_normalize = require("../format/normalize.js");
const HASH_LEN = 12;
const PAGE_BREAK = "\f";
function fold(text) {
  return (0, import_normalize.normalizeText)(String(text ?? "")).replace(/\s+/g, "");
}
async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function blockHash(text) {
  return (await sha256Hex(fold(text))).slice(0, HASH_LEN);
}
function findQuote(text, quote) {
  const q = fold(quote);
  if (!q) return null;
  const src = (0, import_normalize.normalizeText)(String(text ?? ""));
  const map = [];
  let folded = "";
  for (let i = 0; i < src.length; i++) {
    if (/\s/.test(src[i])) continue;
    map.push(i);
    folded += src[i];
  }
  const at = folded.indexOf(q);
  if (at < 0) return null;
  return { start: map[at], end: map[at + q.length - 1] + 1, foldedStart: at, foldedEnd: at + q.length };
}
const LINE_TOL = 0.5;
const BLOCK_GAP = 1.8;
const WORD_GAP = 0.25;
function blocksFromPdfItems(items, pageHeight) {
  const lines = [];
  for (const it of items) {
    if (typeof it?.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || it.height || 10;
    const w = it.width || 0;
    let line = lines.find((l) => Math.abs(l.y - y) < LINE_TOL * Math.max(h, l.h));
    if (!line) {
      line = { y, h, items: [] };
      lines.push(line);
    }
    line.items.push({ x, w, h, str: it.str });
    line.h = Math.max(line.h, h);
  }
  lines.sort((a, b) => b.y - a.y || 0);
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  const groups = [];
  let cur = null;
  let prev = null;
  for (const l of lines) {
    if (!cur || prev.y - l.y > BLOCK_GAP * Math.max(prev.h, l.h)) {
      cur = [];
      groups.push(cur);
    }
    cur.push(l);
    prev = l;
  }
  return groups.map((g) => {
    const text = g.map((l) => joinLine(l.items)).join("\n").trim();
    const xs = g.flatMap((l) => l.items.map((i) => i.x));
    const xe = g.flatMap((l) => l.items.map((i) => i.x + i.w));
    const top = Math.max(...g.map((l) => l.y + l.h));
    const bottom = Math.min(...g.map((l) => l.y - 0.25 * l.h));
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xe);
    return { text, bbox: [r1(x0), r1(pageHeight - top), r1(x1 - x0), r1(top - bottom)], fontSize: r1(Math.max(...g.map((l) => l.h))) };
  }).filter((b) => b.text);
}
function joinLine(items) {
  let out = "";
  let prev = null;
  for (const it of items) {
    if (prev && it.x - (prev.x + prev.w) > WORD_GAP * Math.max(it.h, prev.h) && !out.endsWith(" ") && !it.str.startsWith(" ")) out += " ";
    out += it.str;
    prev = it;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}
const r1 = (n) => Math.round(n * 10) / 10;
function titleOf(blocks) {
  if (!blocks.length) return void 0;
  const sizes = blocks.map((b) => b.fontSize).filter((n) => n > 0).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const first = blocks[0];
  const t = first.text.replace(/\s+/g, " ");
  return first.fontSize >= median * 1.3 && t.length <= 60 && !t.includes("\n") ? t : void 0;
}
function paragraphsToBlocks(text) {
  const out = [];
  let buf = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) out.push({ text: t });
    buf = [];
  };
  for (const line of (0, import_normalize.normalizeText)(String(text ?? "")).split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push({ text: line.trim() });
      continue;
    }
    buf.push(line.trimEnd());
  }
  flush();
  return out;
}
async function hashPages(pages) {
  const out = [];
  for (const p of pages) {
    const blocks = [];
    for (const b of p.blocks) {
      if (!b.text || !fold(b.text)) continue;
      const { fontSize, ...rest } = b;
      void fontSize;
      blocks.push({ hash: await blockHash(b.text), ...rest });
    }
    out.push({ idx: p.idx, ...p.title ? { title: p.title } : {}, blocks });
  }
  return out;
}
function pagesToText(pages) {
  return pages.map((p) => p.blocks.map((b) => b.text).join("\n\n")).join(`
${PAGE_BREAK}
`);
}
function shortSha(sha) {
  return String(sha).replace(/^sha256:/, "").slice(0, HASH_LEN);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HASH_LEN,
  PAGE_BREAK,
  blockHash,
  blocksFromPdfItems,
  findQuote,
  fold,
  hashPages,
  pagesToText,
  paragraphsToBlocks,
  sha256Hex,
  shortSha,
  titleOf
});
