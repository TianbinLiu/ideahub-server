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
var demoTeacher_exports = {};
__export(demoTeacher_exports, {
  demoReply: () => demoReply
});
module.exports = __toCommonJS(demoTeacher_exports);
var import_quiz = require("./quiz.js");
var import_blocks = require("../materials/blocks.js");
const firstSentence = (s) => String(s ?? "").split(/(?<=[。！？；.!?])/)[0]?.trim() || String(s ?? "").slice(0, 60);
const textOf = (x) => typeof x === "string" ? x : x?.text ?? "";
function demoReply(p) {
  const { doc, stageId } = p;
  const st = doc.distill[stageId] || {};
  const stage = doc.map.stages.find((s) => s.stage_id === stageId);
  const cp = doc.card?.catchphrases?.[0] || "\u5148\u7B97\uFF0C\u7B97\u5B8C\u518D\u8C08\u6982\u5FF5\u3002";
  const anchor = p.selection?.anchor;
  const ref = anchor?.page ? ` [[p${anchor.page}]]` : "";
  const quote = anchor?.quote || (p.selection?.text ? p.selection.text.trim().slice(0, 40) : "");
  const memo = (st.must_memorize || []).map(textOf).filter(Boolean);
  const hint1 = firstSentence(st.method || "");
  const hint2 = memo[0] || "";
  switch (p.kind) {
    case "teach":
      return `${cp}

${st.method || `\u8FD9\u4E00\u9636\u6BB5\u662F\u300C${stage?.title ?? stageId}\u300D\u3002`}

\u6709\u95EE\u9898\u5417\uFF0C\u8FD8\u662F\u4E0B\u4E00\u9636\u6BB5\uFF1F`;
    case "ask": {
      if (p.direct) {
        if (!String(p.selfExplain ?? "").trim()) return `\u5148\u7528\u4E00\u53E5\u8BDD\u8BF4\u8BF4\u4F60\u73B0\u5728\u662F\u600E\u4E48\u7406\u89E3${quote ? `\u300C${quote}\u300D` : "\u8FD9\u4E00\u5904"}\u7684\uFF1F\u8BF4\u5B8C\u6211\u5C31\u76F4\u63A5\u8BB2\u3002`;
        return `\u597D\uFF0C\u4F60\u8BF4\u7684\u662F\u300C${String(p.selfExplain).trim().slice(0, 60)}\u300D\u3002\u76F4\u63A5\u8BB2\uFF1A${st.method || ""}${ref}

\u8FD9\u4E00\u5904\u8981\u8BB0\u4F4F\u7684\u662F\uFF1A${hint2 || "\u5148\u7B97\uFF0C\u518D\u8C08\u6982\u5FF5"}\u3002

\u8FD8\u6709\u95EE\u9898\u5417\uFF1F`;
      }
      const q = quote ? `\u4F60\u5708\u7684\u8FD9\u53E5\u300C${quote}\u300D${ref} \u91CC\u6709\u51E0\u4E2A\u91CF\uFF1F\u628A\u5B83\u4EEC\u548C\u5355\u4F4D\u5199\u4E0B\u6765\u3002` : "\u4F60\u624B\u4E0A\u6709\u51E0\u4E2A\u6570\uFF1F\u628A\u5B83\u4EEC\u548C\u5355\u4F4D\u5199\u4E0B\u6765\u3002";
      return `${q}

${/[。！？!?.]$/.test(cp) ? cp : `${cp}\u3002`}\u5148\u4E0D\u76F4\u63A5\u8BB2\u3002

\u63D0\u793A 1\uFF1A${hint1}
\u63D0\u793A 2\uFF08\u8FD8\u5361\u7740\u518D\u770B\uFF09\uFF1A${hint2}${ref}

\u60F3\u76F4\u63A5\u542C\u6211\u8BB2\u4E5F\u884C \u2014\u2014 \u5148\u7528\u4E00\u53E5\u8BDD\u8BF4\u8BF4\u4F60\u73B0\u5728\u7684\u7406\u89E3\u3002`;
    }
    case "quiz-from-selection": {
      const memoHits = [...st.must_memorize || [], ...st.pitfalls || []].map(textOf).filter((m) => quote && (0, import_blocks.fold)(m).includes((0, import_blocks.fold)(quote)));
      const latin = new Set([quote, p.selection?.text || "", ...memoHits].join(" ").match(/[A-Za-z]{2,}/g) || []);
      const grams = [...(0, import_quiz.bigrams)(quote || p.selection?.text || "")];
      const score = (c) => {
        const t = `${c.q} ${c.a}`;
        const ft = (0, import_blocks.fold)(t);
        return [...latin].filter((w) => new RegExp(`\\b${w}\\b`, "i").test(t)).length * 2 + grams.filter((g) => ft.includes(g)).length;
      };
      const best = (st.self_checks || []).map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s > 0) return `\u51FA\u4E00\u9898\uFF1A${best.c.q}\uFF08\u7B54\u5B8C\u6211\u5BF9\u7B54\u6848\u3002\uFF09${ref}`;
      return `\u51FA\u4E00\u9898\uFF1A\u8BF7\u7528\u81EA\u5DF1\u7684\u8BDD\u89E3\u91CA\u300C${quote || "\u8FD9\u4E00\u6BB5"}\u300D${ref} \u2014\u2014 \u5B83\u91CC\u9762\u6BCF\u4E2A\u91CF\u7684\u5355\u4F4D\u662F\u4EC0\u4E48\uFF1F\u7B97\u4E00\u4E2A\u4F8B\u5B50\u7ED9\u6211\u770B\u3002`;
    }
    default:
      return "\u6709\u95EE\u9898\u5417\uFF0C\u8FD8\u662F\u4E0B\u4E00\u9636\u6BB5\uFF1F";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  demoReply
});
