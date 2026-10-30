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
var render_exports = {};
__export(render_exports, {
  renderTutorDoc: () => renderTutorDoc,
  stripSections: () => stripSections
});
module.exports = __toCommonJS(render_exports);
var import_constants = require("./constants.js");
var import_frontmatter = require("./frontmatter.js");
var import_checksum = require("./checksum.js");
var import_normalize = require("./normalize.js");
var import_markdown = require("./markdown.js");
const tail = (obj) => obj?.anchor ? ` ${(0, import_constants.renderAnchor)(obj.anchor)}` : "";
const metaTail = (x) => {
  const s = (0, import_constants.renderStagedMeta)(x);
  return s ? ` ${s}` : "";
};
const itemLine = (x) => typeof x === "string" ? x : `${x.text}${tail(x)}`;
const h2 = (sec) => `## ${sec.num} ${sec.zh}`;
const h3 = (title) => `### ${title}`;
function renderTutorDoc(doc, opts = {}) {
  const withChecksum = opts.withChecksum !== false;
  const raw = doc.raw || {};
  const notes = raw.notes || {};
  const leftovers = raw.leftovers || {};
  const rawSubs = raw.subsections || [];
  const rawSecs = raw.sections || [];
  const out = [];
  const label = (0, import_constants.explicitLabelLine)({ producer: doc.AIGC?.ContentProducer ?? "", id: doc.id, version: doc.version });
  out.push(label, "");
  for (const s of rawSecs.filter((r) => r.after === "")) pushRawSection(out, s);
  const emitRawSubs = (section, after) => {
    for (const r of rawSubs.filter((x) => x.section === section && x.after === after)) {
      out.push(h3(r.heading), ...r.text ? [r.text] : [], "");
    }
  };
  const emitLeftover = (key) => {
    if (leftovers[key]) out.push(leftovers[key], "");
  };
  const emitRawSecs = (afterKey) => {
    for (const s of rawSecs.filter((r) => r.after === afterKey)) pushRawSection(out, s);
  };
  const emitNote = (key) => {
    if (notes[key] !== void 0) out.push(`\uFF08${notes[key]}\uFF09`);
  };
  out.push(h2(import_constants.SECTIONS[0]), "");
  emitLeftover("card._preamble");
  emitRawSubs("card", null);
  const c = doc.card;
  for (const s of import_constants.CARD_SUBS) {
    const lines = [];
    switch (s.key) {
      case "who":
        if (c.who) lines.push(c.who);
        break;
      case "teaching_style":
        if (c.teaching_style) lines.push(c.teaching_style);
        break;
      case "catchphrases":
        lines.push(...c.catchphrases.map((x) => `- ${x}`));
        break;
      case "hard_rules":
        lines.push(...c.hard_rules.map((r) => `- ${r.locked ? "\u{1F512} " : ""}${r.text}`));
        break;
      case "greeting_closing":
        if (c.greeting !== void 0 && c.greeting !== "") lines.push(`- \u5F00\u573A\uFF1A${c.greeting}`);
        if (c.closing !== void 0 && c.closing !== "") lines.push(`- \u6536\u5C3E\uFF1A${c.closing}`);
        break;
      case "example_turns":
        for (const t of c.example_turns) lines.push(`- **\u5B66\u751F**\uFF1A${t.student}`, `- **\u8001\u5E08**\uFF1A${t.teacher}`);
        break;
    }
    const hasNote = notes[`card.${s.key}`] !== void 0;
    const hasLeft = !!leftovers[`card.${s.key}`];
    if (lines.length || hasNote || hasLeft) {
      out.push(h3(s.zh));
      emitNote(`card.${s.key}`);
      out.push(...lines);
      if (hasLeft) out.push(leftovers[`card.${s.key}`]);
      out.push("");
    }
    emitRawSubs("card", s.key);
  }
  emitRawSecs("card");
  out.push(h2(import_constants.SECTIONS[1]));
  emitNote("profile");
  out.push("");
  emitLeftover("profile._preamble");
  emitRawSubs("profile", null);
  const p = doc.profile;
  for (const s of import_constants.PROFILE_SUBS) {
    const lines = [];
    switch (s.key) {
      case "pace":
        if (p.pace) lines.push(...p.pace.split("\n").map((x) => `- ${x}`));
        break;
      case "preferences":
        lines.push(...p.preferences.map((x) => `- ${x}`));
        break;
      default:
        lines.push(...(p[s.key] || []).map((x) => `- [${x.stage_id}] ${x.text}${tail(x)}${metaTail(x)}`));
    }
    const noteKey = `profile.${s.key}`;
    const hasNote = notes[noteKey] !== void 0;
    const hasLeft = !!leftovers[noteKey];
    const required = s.key !== "misconceptions";
    if (lines.length || hasNote || hasLeft || required) {
      out.push(h3(s.zh));
      if (hasNote) out.push(`\uFF08${notes[noteKey]}\uFF09`);
      else if (!lines.length && !hasLeft && s.key === "stuck_points") out.push(import_constants.EMPTY_NOTES.stuck_points);
      out.push(...lines);
      if (hasLeft) out.push(leftovers[noteKey]);
      out.push("");
    }
    emitRawSubs("profile", s.key);
  }
  emitRawSecs("profile");
  out.push(h2(import_constants.SECTIONS[2]), "");
  const m = doc.map;
  const withSummary = m.stages.some((st) => st.summary);
  const cols = import_constants.MAP_COLUMNS.filter((col) => col.key !== "summary" || withSummary);
  out.push((0, import_markdown.renderTable)(cols.map((col) => col.zh), m.stages.map((st) => cols.map((col) => String(st[col.key] ?? "")))), "");
  emitLeftover("map._preamble");
  emitRawSubs("map", null);
  for (const s of import_constants.MAP_SUBS) {
    const lines = [];
    if (s.key === "key_dates") lines.push(...m.key_dates.map((d) => `- ${d.label} \xB7 ${d.at} \xB7 ${d.kind}`));
    else lines.push(...(m.source_material_hashes || []).map((x) => `- ${x}`));
    const noteKey = `map.${s.key}`;
    if (lines.length || notes[noteKey] !== void 0 || leftovers[noteKey]) {
      out.push(h3(s.zh));
      emitNote(noteKey);
      out.push(...lines);
      if (leftovers[noteKey]) out.push(leftovers[noteKey]);
      out.push("");
    }
    emitRawSubs("map", s.key);
  }
  emitRawSecs("map");
  out.push(h2(import_constants.SECTIONS[3]), "");
  emitLeftover("distill._preamble");
  emitRawSubs("distill", null);
  const order = [...m.stages.map((st) => st.stage_id).filter((id) => doc.distill[id]), ...Object.keys(doc.distill).filter((id) => !m.stages.some((st) => st.stage_id === id))];
  const titleOf = (id) => doc.distill[id].title ?? m.stages.find((st) => st.stage_id === id)?.title ?? "";
  for (const id of order) {
    const st = doc.distill[id];
    out.push(h3(`[${id}] ${titleOf(id)}`));
    for (const s of import_constants.DISTILL_SUBS) {
      const lines = [];
      switch (s.key) {
        case "method":
          if (st.method) lines.push(st.method);
          break;
        case "walkthrough":
          (st.walkthrough || []).forEach((w, i) => lines.push(`${i + 1}. ${w.say}${w.ask ? ` \uFF0F \u95EE\uFF1A${w.ask}` : ""}${tail(w)}`));
          break;
        case "must_memorize":
          lines.push(...st.must_memorize.map((x) => `- ${itemLine(x)}`));
          break;
        case "pitfalls":
          lines.push(...st.pitfalls.map((x) => `- ${itemLine(x)}`));
          break;
        case "self_checks":
          st.self_checks.forEach((q, i) => lines.push(`${i + 1}. **\u9898**\uFF1A${q.q} \uFF0F **\u7B54**\uFF1A${q.a} \uFF0F \u7C7B\u578B\uFF1A${import_constants.SELF_CHECK_KINDS_REV[q.kind]}${q.rubric ? ` \uFF0F \u8BC4\u5206\uFF1A${q.rubric}` : ""}${tail(q)}`));
          break;
        case "student_qa":
          lines.push(...st.student_qa.map((qa) => `- **\u95EE**\uFF1A${qa.q} \uFF0F **\u7B54**\uFF1A${qa.a}${qa.from_turn !== void 0 ? `\uFF08t:${qa.from_turn}\uFF09` : ""}${tail(qa)}`));
          break;
      }
      const noteKey = `distill.${id}.${s.key}`;
      if (lines.length || notes[noteKey] !== void 0) {
        out.push(`#### ${s.zh}`);
        emitNote(noteKey);
        out.push(...lines);
      }
    }
    if (st.raw?.length) out.push(...st.raw);
    out.push("");
    emitRawSubs("distill", id);
  }
  emitRawSecs("distill");
  out.push(h2(import_constants.SECTIONS[4]));
  emitNote("log");
  out.push("");
  emitLeftover("log._preamble");
  emitRawSubs("log", null);
  for (const ex of doc.log_excerpts) {
    const range = ex.turn_from !== void 0 ? ` \xB7 t:${ex.turn_from}\u2013${ex.turn_to}` : "";
    out.push(h3(`[${ex.stage_id}${range}] ${ex.why}`.replace(/\s+$/, "")));
    for (const t of ex.turns) out.push(`- **${t.role === "student" ? "\u5B66\u751F" : "\u8001\u5E08"}**\uFF1A${t.text}`);
    const key = `log.${ex.stage_id}:${ex.turn_from ?? ""}`;
    if (leftovers[key]) out.push(leftovers[key]);
    out.push("");
    emitRawSubs("log", key.slice(4));
  }
  emitRawSecs("log");
  out.push(h2(import_constants.SECTIONS[5]), "");
  emitLeftover("guide._preamble");
  emitRawSubs("guide", null);
  for (const s of import_constants.GUIDE_SUBS) {
    const text2 = doc.guide[s.key] ?? "";
    const noteKey = `guide.${s.key}`;
    out.push(h3(s.zh));
    emitNote(noteKey);
    if (text2) out.push(text2);
    out.push("");
    emitRawSubs("guide", s.key);
  }
  emitRawSecs("guide");
  out.push(label);
  const body = (0, import_normalize.canonicalBody)(out.join("\n"));
  const checksum = withChecksum ? (0, import_checksum.bodyChecksum)(body) : doc.checksum;
  const fm = { ...stripSections(doc) };
  if (checksum) fm.checksum = checksum;
  const text = `---
${(0, import_frontmatter.renderFrontmatter)(fm, raw.frontmatter || {})}---
${body}`;
  return { text, checksum };
}
function pushRawSection(out, s) {
  if (s.heading) out.push(`## ${s.heading}`);
  if (s.text) out.push(s.text);
  out.push("");
}
function stripSections(doc) {
  const { card: _c, profile: _p, profile_seed: _ps, map: _m, distill: _d, log_excerpts: _l, guide: _g, raw: _r, ...fm } = doc;
  return fm;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  renderTutorDoc,
  stripSections
});
