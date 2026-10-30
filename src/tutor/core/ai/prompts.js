// 提示词冻结中文放 core/prompts/*.md（docs/06 §2.1）：进模型的文本不进 i18n 目录。
// 与 tutor 仓 src/ai/prompts.js 同一份逻辑；只是 CJS 里没有 import.meta.url，改用 __dirname（这是 core 里少数手写、不由 port-core 生成的文件）。
"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { catalogForPrompt } = require("../ops/catalog.js");

const dir = join(__dirname, "..", "prompts");

function loadPrompt(name, vars = {}) {
  let text = readFileSync(join(dir, `${name}.md`), "utf8");
  const all = { op_catalog_distill: catalogForPrompt("distill"), op_catalog_scan: catalogForPrompt("scan"), ...vars };
  text = text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in all ? String(all[k]) : m));
  const left = text.match(/\{\{\w+\}\}/g);
  if (left) throw new Error(`提示词 ${name} 还有没填的占位符：${[...new Set(left)].join(" ")}`);
  return text;
}
module.exports = { loadPrompt };
