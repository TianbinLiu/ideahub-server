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
var sections_exports = {};
__export(sections_exports, {
  CHUNK_MAX: () => CHUNK_MAX,
  PAGES_PER_SECTION: () => PAGES_PER_SECTION,
  SECTION_HEAD_RE: () => SECTION_HEAD_RE,
  SLIDE_AVG_CHARS: () => SLIDE_AVG_CHARS,
  chunksOf: () => chunksOf,
  outlineOf: () => outlineOf,
  sectionText: () => sectionText,
  sectionsOf: () => sectionsOf
});
module.exports = __toCommonJS(sections_exports);
var import_blocks = require("../materials/blocks.js");
const CHUNK_MAX = 1500;
const SLIDE_AVG_CHARS = 300;
const PAGES_PER_SECTION = { slides: 4, document: 8 };
const SECTION_HEAD_RE = /^(第\s*[一二三四五六七八九十百零\d]+\s*[章讲周节部分单元课]|(chapter|lecture|week|unit|module|lesson|part)\s*\d+|\d{1,2}(\.\d{1,2})*\s*[.、．]\s*\S|\d{1,2}\s+\S)/i;
function sectionsOf(pages, meta = {}) {
  const list = (pages || []).filter((p) => p.blocks?.length);
  if (!list.length) return [];
  const titleOfPage = (p) => (p.title || p.blocks[0]?.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const heads = list.map((p) => SECTION_HEAD_RE.test(titleOfPage(p)));
  const headCount = heads.filter(Boolean).length;
  const avg = list.reduce((n, p) => n + (0, import_blocks.fold)(p.blocks.map((b) => b.text).join("")).length, 0) / list.length;
  const per = avg < SLIDE_AVG_CHARS ? PAGES_PER_SECTION.slides : PAGES_PER_SECTION.document;
  const groups = [];
  let cur = null;
  list.forEach((p, i) => {
    const byHead = headCount >= 2 && heads[i];
    const bySize = headCount < 2 && i % per === 0;
    if (!cur || byHead || bySize) {
      cur = { pages: [] };
      groups.push(cur);
    }
    cur.pages.push(p);
  });
  return groups.map((g, i) => {
    const chunks = chunksOf(g.pages);
    return {
      idx: i + 1,
      ...meta.material ? { material: meta.material } : {},
      title: titleOfPage(g.pages[0]) || `\u7B2C ${i + 1} \u8282`,
      fromPage: g.pages[0].idx,
      toPage: g.pages.at(-1).idx,
      chars: chunks.reduce((n, c) => n + (0, import_blocks.fold)(c.text).length, 0),
      chunks,
      /** 摊平的块（带页码与块 hash）：演示生成挑关键句用；模型路只用 chunks */
      blocks: g.pages.flatMap((p) => p.blocks.map((b) => ({ page: p.idx, ...b.hash ? { hash: b.hash } : {}, text: b.text }))),
      /** 每页的标题（抽文本时按字号认的）：演示生成挑关键句时跳过它们 —— 「第二段：信号在介质里走」带冒号会被当成定义句，其实是页标题 */
      pageTitles: g.pages.map((p) => p.title || "").filter(Boolean)
    };
  });
}
function chunksOf(pages) {
  const out = [];
  let buf = [];
  let bufLen = 0;
  let bufPage = pages[0]?.idx ?? 1;
  const flush = () => {
    if (buf.length) out.push({ idx: out.length + 1, page: bufPage, text: buf.join("\n\n") });
    buf = [];
    bufLen = 0;
  };
  for (const p of pages) {
    if (buf.length) flush();
    for (const b of p.blocks) {
      const t = String(b.text || "").trim();
      if (!t) continue;
      if (bufLen + t.length > CHUNK_MAX && buf.length) flush();
      if (!buf.length) bufPage = p.idx;
      buf.push(t);
      bufLen += t.length;
    }
  }
  flush();
  return out;
}
function sectionText(sections, max = 12e3) {
  const parts = [];
  let n = 0;
  for (const s of sections) {
    parts.push(`\u3010${s.title}\uFF08p${s.fromPage}\u2013${s.toPage}\uFF09\u3011`);
    for (const c of s.chunks) {
      if (n + c.text.length > max) {
        parts.push("\uFF08\u2026\u2026\u540E\u9762\u7684\u5185\u5BB9\u88AB\u622A\u65AD\uFF09");
        return parts.join("\n");
      }
      parts.push(`[p${c.page}] ${c.text}`);
      n += c.text.length;
    }
  }
  return parts.join("\n");
}
function outlineOf(sections, headChars = 300) {
  return sections.map((s) => `\xA7${s.idx} \u300C${s.title}\u300D\uFF08p${s.fromPage}\u2013${s.toPage}\uFF0C${s.chars} \u5B57\uFF09\uFF1A${s.chunks.map((c) => c.text).join(" ").replace(/\s+/g, " ").slice(0, headChars)}`).join("\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHUNK_MAX,
  PAGES_PER_SECTION,
  SECTION_HEAD_RE,
  SLIDE_AVG_CHARS,
  chunksOf,
  outlineOf,
  sectionText,
  sectionsOf
});
