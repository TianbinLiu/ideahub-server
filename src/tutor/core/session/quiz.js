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
var quiz_exports = {};
__export(quiz_exports, {
  BIGRAM_PASS: () => BIGRAM_PASS,
  answerNumbers: () => answerNumbers,
  bigramOverlap: () => bigramOverlap,
  bigrams: () => bigrams,
  gradeAnswer: () => gradeAnswer,
  gradeQuiz: () => gradeQuiz
});
module.exports = __toCommonJS(quiz_exports);
var import_blocks = require("../materials/blocks.js");
const BIGRAM_PASS = 0.35;
function bigrams(s) {
  const f = (0, import_blocks.fold)(s);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + 1 < f.length; i++) out.add(f.slice(i, i + 2));
  return out;
}
function bigramOverlap(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / A.size;
}
const NUM_RE = /\d+(?:[.,]\d+)*/g;
const normNum = (s) => s.replace(/,/g, "").replace(/\.0+$/, "");
function answerNumbers(reference) {
  const r = String(reference ?? "");
  const tail = r.includes("=") ? r.slice(r.lastIndexOf("=") + 1) : r.split(/[；;。]/)[0];
  const nums = (tail.match(NUM_RE) || []).map(normNum);
  return nums.length ? nums : (r.match(NUM_RE) || []).map(normNum);
}
function gradeAnswer(check, answer) {
  const given = String(answer ?? "").trim();
  if (!given) return { correct: false, why: "\u6CA1\u6709\u4F5C\u7B54" };
  const kind = check.kind || "concept";
  if (kind === "calc") {
    const want = answerNumbers(check.a);
    const have = new Set((given.match(NUM_RE) || []).map(normNum));
    if (want.length && want.some((n) => have.has(n))) return { correct: true, why: `\u7ED3\u679C\u6570 ${want.find((n) => have.has(n))} \u5BF9\u4E0A\u4E86` };
    if (!want.length) return gradeAnswer({ ...check, kind: "concept" }, given);
    return { correct: false, why: `\u6CA1\u7B97\u5230 ${want.join(" / ")}` };
  }
  const overlap = bigramOverlap(check.a, given);
  return overlap >= BIGRAM_PASS ? { correct: true, why: `\u4E0E\u53C2\u8003\u7B54\u6848\u91CD\u5408 ${Math.round(overlap * 100)}%` } : { correct: false, why: `\u4E0E\u53C2\u8003\u7B54\u6848\u53EA\u91CD\u5408 ${Math.round(overlap * 100)}%` };
}
function gradeQuiz(checks, answers) {
  const results = checks.map((c, i) => {
    const g = gradeAnswer(c, answers?.[i]);
    return { q: c.q, kind: c.kind, expected: c.a, given: String(answers?.[i] ?? ""), ...g };
  });
  return { results, correct: results.filter((r) => r.correct).length, asked: results.length };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BIGRAM_PASS,
  answerNumbers,
  bigramOverlap,
  bigrams,
  gradeAnswer,
  gradeQuiz
});
