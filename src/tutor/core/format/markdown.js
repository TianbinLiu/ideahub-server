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
var markdown_exports = {};
__export(markdown_exports, {
  NOTE_RE: () => NOTE_RE,
  matchSub: () => matchSub,
  parseBlockText: () => parseBlockText,
  parseList: () => parseList,
  parseTable: () => parseTable,
  renderTable: () => renderTable,
  splitByHeading: () => splitByHeading,
  takeNote: () => takeNote
});
module.exports = __toCommonJS(markdown_exports);
const FENCE_RE = /^(```|~~~)/;
function splitByHeading(lines, level) {
  const re = new RegExp(`^#{${level}}\\s+(.*?)\\s*#*\\s*$`);
  const chunks = [{ heading: null, lines: [] }];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = !inFence && re.exec(line);
    if (m && !line.startsWith("#".repeat(level + 1))) chunks.push({ heading: m[1], lines: [] });
    else chunks[chunks.length - 1].lines.push(line);
  }
  return chunks;
}
const NOTE_RE = /^（.*）$/;
function takeNote(lines) {
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx >= 0 && NOTE_RE.test(lines[idx].trim())) {
    const note = lines[idx].trim().slice(1, -1);
    return { note, rest: [...lines.slice(0, idx), ...lines.slice(idx + 1)] };
  }
  return { note: null, rest: lines };
}
const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
function parseList(lines) {
  const items = [];
  const leftovers = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = ITEM_RE.exec(line);
    if (m) items.push(m[2].trim());
    else if (items.length && /^\s{2,}\S/.test(line)) items[items.length - 1] += "\n" + line.trim();
    else leftovers.push(line);
  }
  return { items, leftovers };
}
function parseBlockText(lines) {
  const arr = [...lines];
  while (arr.length && arr[0].trim() === "") arr.shift();
  while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
  return arr.map((l) => l.replace(/\s+$/, "")).join("\n");
}
function parseTable(lines) {
  const tableLines = [];
  const leftovers = [];
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) tableLines.push(line.trim());
    else if (line.trim() !== "") leftovers.push(line);
  }
  if (tableLines.length < 2) return { header: null, rows: [], leftovers: [...leftovers, ...tableLines] };
  const cells = (l) => l.slice(1, -1).split("|").map((c) => c.trim());
  const header = cells(tableLines[0]);
  const rows = tableLines.slice(1).filter((l) => !/^\|[\s:|-]+\|$/.test(l)).map(cells);
  return { header, rows, leftovers };
}
function renderTable(header, rows) {
  const out = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  return out.join("\n");
}
function matchSub(heading, subs) {
  if (heading == null) return null;
  const h = heading.trim();
  return subs.find((s) => s.zh === h || s.en.toLowerCase() === h.toLowerCase()) || null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NOTE_RE,
  matchSub,
  parseBlockText,
  parseList,
  parseTable,
  renderTable,
  splitByHeading,
  takeNote
});
