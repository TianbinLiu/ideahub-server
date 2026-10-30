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
var pipeline_exports = {};
__export(pipeline_exports, {
  MAX_TOKENS: () => MAX_TOKENS,
  STAGE_INPUT_CHARS: () => STAGE_INPUT_CHARS,
  anchorDistill: () => anchorDistill,
  planGenerate: () => planGenerate,
  proposeStages: () => proposeStages,
  runGenerate: () => runGenerate
});
module.exports = __toCommonJS(pipeline_exports);
var import_client = require("../ai/client.js");
var import_prompts = require("../ai/prompts.js");
var import_scrubPii = require("../ops/scrubPii.js");
var import_anchors = require("../materials/anchors.js");
var import_blocks = require("../materials/blocks.js");
var import_sections = require("./sections.js");
var import_schemas = require("./schemas.js");
var import_demo = require("./demo.js");
var import_assemble = require("./assemble.js");
var import_pricing = require("./pricing.js");
const MAX_TOKENS = { stages: 2400, stage: 3e3, card: 2500 };
const STAGE_INPUT_CHARS = 12e3;
function planGenerate(materials) {
  let n = 0;
  const sections = [];
  for (const m of materials) for (const s of (0, import_sections.sectionsOf)(m.pages, { material: (0, import_blocks.shortSha)(m.sha), ext: m.ext })) sections.push({ ...s, idx: ++n, sha: m.sha, materialName: m.name });
  return { sections, quote: (0, import_pricing.generateQuote)({ materials: materials.length, stages: Math.max(1, sections.length), demo: !(0, import_client.aiConfig)() }) };
}
async function runGenerate(p) {
  const env = p.env || process.env;
  const cfg = (0, import_client.aiConfig)(env);
  const mode = cfg ? "model" : "demo";
  const progress = p.onProgress || (() => {
  });
  const { sections } = planGenerate(p.materials);
  if (!sections.length) throw new Error("\u6559\u6750\u91CC\u4E00\u6BB5\u6587\u5B57\u90FD\u6CA1\u62BD\u51FA\u6765\uFF1A\u6362\u4E00\u4EFD\u5E26\u6587\u5B57\u5C42\u7684\u6587\u4EF6\uFF08\u626B\u63CF\u4EF6 v1 \u4E0D\u652F\u6301 OCR\uFF09");
  const total = 1 + p.materials.length + sections.length + 2;
  let done = 0;
  const tick = (step, message) => progress({ step, done: ++done, total, message, mode });
  tick("sections", `\u5207\u7AE0\u8282\uFF1A${p.materials.length} \u4EFD\u6559\u6750 \u2192 ${sections.length} \u8282`);
  const key = JSON.stringify({ shas: p.materials.map((m) => m.sha).sort(), q: p.questionnaire });
  const saved = p.checkpoint?.read?.();
  const ck = saved && saved.key === key ? saved : { key, stages: null, distills: {}, card: null, guide: null, calls: 0 };
  const save = () => p.checkpoint?.write?.(ck);
  const pagesBySha = Object.fromEntries(p.materials.map((m) => [m.sha, m.pages]));
  const preset = (0, import_demo.presetOf)(p.questionnaire.style);
  const teacherName = String(p.questionnaire.name || "\u8001\u5E08").trim().slice(0, 40);
  const styleText = `${preset.label}\uFF1A${preset.teaching_style}`;
  const failures = [];
  const proposed = await proposeStages({ sections, materials: p.materials, teacherName, subject: p.course.subject, courseTitle: p.course.title, styleText, preset, existing: [], env, mode, ck, save, pagesBySha, failures, tick });
  void proposed;
  if (!ck.card) {
    const hardRules = (0, import_demo.hardRulesFrom)(p.course.policy, p.course.key_dates || [], p.questionnaire.extra_rules || []);
    if (mode === "demo") {
      ck.card = { ...(0, import_demo.demoCard)(p.questionnaire, p.course.subject), hard_rules: hardRules };
      ck.guide = (0, import_demo.demoGuide)({ name: teacherName, subject: p.course.subject, policy: p.course.policy, greeting: ck.card.greeting });
    } else {
      const prompt = (0, import_prompts.loadPrompt)("generate", { teacher_name: teacherName, subject: p.course.subject, course_title: p.course.title, style_hint: `${styleText}${p.questionnaire.catchphrase ? `\uFF1B\u53E3\u5934\u7985\uFF1A${p.questionnaire.catchphrase}` : ""}${p.questionnaire.strictness ? `\uFF1B\u4E25\u5389\u5EA6\uFF1A${p.questionnaire.strictness}` : ""}${p.questionnaire.examples_from ? `\uFF1B\u4F8B\u5B50\u6765\u6E90\uFF1A${p.questionnaire.examples_from}` : ""}`, policy_ai: p.course.policy?.ai || "limited", homework_mode: p.course.policy?.homework_mode || "principles_only", policy_text: String(p.course.policy?.text || "\uFF08\u672A\u586B\uFF09"), outline: (0, import_scrubPii.scrubPii)((0, import_sections.outlineOf)(sections, 120)) });
      const reply = await askJson(prompt, MAX_TOKENS.card, import_schemas.CardReplySchema, env, "card", "\u2460 \u4EBA\u683C\u5361 + \u2465 \u590D\u523B\u6307\u5357");
      ck.calls++;
      if (!reply) {
        failures.push("\u2460 \u2465 \u4E24\u6B21\u90FD\u6CA1\u62FF\u5230\u5408\u5F62\u72B6\u7684\u56DE\u7B54\uFF0C\u6309\u95EE\u5377\u6A21\u677F\u751F\u6210\uFF08\u8FD9\u4E24\u6B21\u5DF2\u8BA1\u8D39\uFF09");
        ck.card = { ...(0, import_demo.demoCard)(p.questionnaire, p.course.subject), hard_rules: hardRules };
        ck.guide = (0, import_demo.demoGuide)({ name: teacherName, subject: p.course.subject, policy: p.course.policy, greeting: ck.card.greeting });
      } else {
        const { extra_rules, ...card } = reply.card;
        ck.card = { ...card, hard_rules: (0, import_demo.hardRulesFrom)(p.course.policy, p.course.key_dates || [], [...p.questionnaire.extra_rules || [], ...extra_rules || []]), example_turns: card.example_turns || [] };
        ck.guide = reply.guide;
      }
    }
    save();
  }
  tick("card", "\u5199 \u2460 \u8001\u5E08\u4EBA\u683C\u5361 \u4E0E \u2465 \u590D\u523B\u6307\u5357");
  const seed = (0, import_assemble.seedDoc)({
    id: p.docId,
    version: p.version,
    supersedes: p.supersedes,
    course: p.course,
    hashes: p.materials.map((m) => `sha256:${m.sha}`),
    materials: p.materials,
    author: p.author,
    producer: p.producer,
    card: { name: teacherName, style_label: preset.label, ...ck.card },
    guide: ck.guide,
    method: mode === "demo" ? "\u6F14\u793A\u6A21\u5F0F\uFF1A\u6559\u6750\u6309\u7AE0\u8282\u786E\u5B9A\u6027\u5207\u6210\u9636\u6BB5\u3001\u5173\u952E\u53E5\u4F5C\u8BB2\u89E3\u6B65\uFF08\u672A\u8C03\u7528\u6A21\u578B\uFF09" : `\u6559\u6750\u7ECF AI \u5206\u9636\u6BB5\u63D0\u70BC\uFF08${ck.calls} \u6B21\u8C03\u7528\uFF09\uFF0C\u786C\u89C4\u5219\u7531\u8BFE\u7A0B\u653F\u7B56\u6D3E\u751F`
  });
  const proposals = ck.stages.map((st, k) => ({ value: { week: st.week ?? "", title: st.title, summary: st.summary || "", distill: ck.distills[String(k)] }, rationale: `\u8986\u76D6 \xA7${st.sections.join("\u3001\xA7")}` }));
  const out = await (0, import_assemble.assembleDoc)(seed, proposals);
  tick("assemble", `\u7EC4\u88C5 ${out.doc.map.stages.length} \u4E2A\u9636\u6BB5\u5E76\u6821\u9A8C\u901A\u8FC7`);
  return { ...out, mode, calls: ck.calls, failures, sections: sections.length, anchors: ck.anchors || { quotes: 0, hit: 0 } };
}
async function proposeStages({ sections, materials, teacherName, subject, courseTitle, styleText, preset, existing, env, mode, ck, save, pagesBySha, failures, tick }) {
  if (!ck.stages) {
    if (mode === "demo") {
      ck.stages = (0, import_demo.demoStages)(sections);
      ck.stages.forEach((s) => delete s._i);
    } else {
      const stages = [];
      for (const m of materials) {
        const mine = sections.filter((s) => s.sha === m.sha);
        if (!mine.length) continue;
        const known = [...existing, ...stages.map((s) => s.title)];
        const prompt = (0, import_prompts.loadPrompt)("stages", { teacher_name: teacherName, subject, course_title: courseTitle, existing_stages: known.map((t) => `- ${t}`).join("\n") || "\uFF08\u8FD8\u6CA1\u6709\u9636\u6BB5\uFF09", outline: (0, import_scrubPii.scrubPii)((0, import_sections.outlineOf)(mine)) });
        const reply = await askJson(prompt, MAX_TOKENS.stages, import_schemas.StagesReplySchema, env, "stages", `\u9636\u6BB5\u63D0\u8BAE\uFF08${m.name}\uFF09`);
        ck.calls = (ck.calls || 0) + 1;
        if (!reply) {
          failures.push(`\u9636\u6BB5\u63D0\u8BAE\uFF08${m.name}\uFF09\u4E24\u6B21\u90FD\u6CA1\u62FF\u5230\u5408\u5F62\u72B6\u7684\u56DE\u7B54\uFF0C\u8FD9\u4EFD\u6559\u6750\u6309\u7AE0\u8282\u76F4\u63A5\u5207\u6210\u9636\u6BB5\uFF08\u8FD9\u4E24\u6B21\u5DF2\u8BA1\u8D39\uFF09`);
          stages.push(...(0, import_demo.demoStages)(mine).map((s) => {
            delete s._i;
            return s;
          }));
          continue;
        }
        for (const st of reply.stages) {
          const secs = st.sections.filter((i) => mine.some((s) => s.idx === i));
          if (secs.length) stages.push({ week: st.week ?? "", title: st.title, summary: st.summary || "", sections: secs });
        }
        const covered = new Set(stages.flatMap((s) => s.sections));
        for (const s of mine) if (!covered.has(s.idx)) stages.push({ week: "", title: s.title, summary: "", sections: [s.idx] });
      }
      ck.stages = stages;
    }
    save();
  }
  for (const m of materials) tick("stages", `\u9636\u6BB5\u63D0\u8BAE\uFF1A${m.name} \u2192 \u5171 ${ck.stages.length} \u4E2A\u9636\u6BB5`);
  for (const [k, st] of ck.stages.entries()) {
    const skey = String(k);
    const secs = st.sections.map((i) => sections.find((s) => s.idx === i)).filter(Boolean);
    if (!ck.distills[skey]) {
      let d;
      if (mode === "demo") d = (0, import_demo.demoDistill)(st, secs, preset);
      else {
        const prompt = (0, import_prompts.loadPrompt)("stage", { teacher_name: teacherName, subject, stage_title: st.title, teaching_style: styleText, material_text: (0, import_scrubPii.scrubPii)((0, import_sections.sectionText)(secs, STAGE_INPUT_CHARS)) });
        d = await askJson(prompt, MAX_TOKENS.stage, import_schemas.StageReplySchema, env, "stage", `\u84B8\u998F\u300C${st.title}\u300D`);
        ck.calls = (ck.calls || 0) + 1;
        if (!d) {
          failures.push(`\u9636\u6BB5\u300C${st.title}\u300D\u7684\u84B8\u998F\u4E24\u6B21\u90FD\u6CA1\u62FF\u5230\u5408\u5F62\u72B6\u7684\u56DE\u7B54\uFF0C\u8FD9\u4E00\u9636\u6BB5\u5148\u6309\u6F14\u793A\u89C4\u5219\u751F\u6210\uFF08\u8FD9\u4E24\u6B21\u5DF2\u8BA1\u8D39\uFF09`);
          d = (0, import_demo.demoDistill)(st, secs, preset);
        }
      }
      ck.anchors = ck.anchors || { quotes: 0, hit: 0 };
      ck.distills[skey] = anchorDistill(d, secs, pagesBySha, ck.anchors);
      save();
    }
    tick("distill", `\u84B8\u998F ${k + 1}/${ck.stages.length}\uFF1A${st.title}`);
  }
  return ck;
}
async function askJson(prompt, maxTokens, schema, env, kind, what) {
  let text = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await (0, import_client.chat)({ system: "\u4F60\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8F93\u51FA\u4EFB\u4F55\u89E3\u91CA\u3002", user: text, json: true, maxTokens, temperature: 0.3, kind, meta: { what, attempt } }, { env });
      const parsed = schema.safeParse((0, import_client.parseStrictJson)(reply.text));
      if (parsed.success) return parsed.data;
    } catch (e) {
      if (!(e instanceof import_client.AiTruncated) && !/JSON|形状|用不上/.test(e.message)) throw new Error(`${what}\uFF1A${e.message}`, { cause: e });
    }
    text = text.replace(/<<<\n([\s\S]*)\n>>>/, (m, body) => `<<<
${body.slice(0, Math.floor(body.length / 2))}
\uFF08\u2026\u2026\u5DF2\u622A\u65AD\uFF09
>>>`);
  }
  return null;
}
function anchorDistill(d, secs, pagesBySha, stats = null) {
  const shas = [...new Set(secs.map((s) => s.sha))];
  const toAnchor = (q) => {
    if (!q) return void 0;
    if (stats) stats.quotes++;
    for (const sha of shas) {
      const a = (0, import_anchors.locateQuoteInPages)(pagesBySha[sha] || [], q, sha);
      if (a) {
        if (stats) stats.hit++;
        return a;
      }
    }
    return void 0;
  };
  const item = (x) => {
    if (typeof x === "string") return x;
    const a = toAnchor(x.quote);
    return a ? { text: x.text, anchor: a } : x.text;
  };
  return {
    method: d.method,
    walkthrough: (d.walkthrough || []).map((w) => {
      const a = toAnchor(w.quote);
      const s = { say: w.say };
      if (w.ask) s.ask = w.ask;
      if (a) s.anchor = a;
      return s;
    }),
    must_memorize: (d.must_memorize || []).map(item),
    self_checks: (d.self_checks || []).map(({ q, a, kind }) => ({ q, a, kind })),
    pitfalls: (d.pitfalls || []).map(item)
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_TOKENS,
  STAGE_INPUT_CHARS,
  anchorDistill,
  planGenerate,
  proposeStages,
  runGenerate
});
