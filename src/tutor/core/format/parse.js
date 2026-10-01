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
var parse_exports = {};
__export(parse_exports, {
  parseTutorDoc: () => parseTutorDoc
});
module.exports = __toCommonJS(parse_exports);
var import_constants = require("./constants.js");
var import_frontmatter = require("./frontmatter.js");
var import_checksum = require("./checksum.js");
var import_normalize = require("./normalize.js");
var import_markdown = require("./markdown.js");
function splitAnchor(text) {
  const m = import_constants.ANCHOR_TAIL_RE.exec(text);
  if (!m) return { text };
  return { text: text.slice(0, m.index).replace(/\s+$/, ""), anchor: (0, import_constants.parseAnchorMatch)(m) };
}
function splitMeta(text) {
  const m = import_constants.STAGED_META_TAIL_RE.exec(text);
  const meta = m && (0, import_constants.parseStagedMeta)(m[1]);
  if (!meta) return { text };
  return { text: text.slice(0, m.index).replace(/\s+$/, ""), meta };
}
const anchoredItem = (t) => {
  const { text, anchor } = splitAnchor(t);
  return anchor ? { text, anchor } : text;
};
const WALK_RE = /^(.*?)(?:\s*／\s*问[：:]\s*(.*?))?$/s;
const H2_RE = new RegExp(
  `^([\u2460-\u2465])?\\s*(${import_constants.SECTIONS.map((s) => `${s.zh}|${s.en}`).join("|")})$`,
  "i"
);
const STAGE_H3_RE = /^\[(stage-\d{2,3})\]\s*(.*)$/;
const LOG_H3_RE = /^\[(stage-\d{2,3})(?:\s*·\s*t:(\d+)\s*[–—-]\s*(\d+))?\]\s*(.*)$/;
const STAGED_ITEM_RE = /^\[(stage-\d{2,3})\]\s*(.*)$/;
const TURN_RE = /^\*\*(学生|老师|Student|Teacher)\*\*[：:]\s*(.*)$/s;
const SELF_CHECK_RE = /^\*\*题\*\*[：:]\s*(.*?)\s*／\s*\*\*答\*\*[：:]\s*(.*?)\s*／\s*类型[：:]\s*(计算|概念|排错)(?:\s*／\s*评分[：:]\s*(.*?))?\s*$/s;
const STUDENT_QA_RE = /^\*\*问\*\*[：:]\s*(.*?)\s*／\s*\*\*答\*\*[：:]\s*(.*?)(?:（t:(\d+)）)?\s*$/s;
const GREETING_RE = /^(?:开场|Greeting)[：:]\s*(.*)$/s;
const CLOSING_RE = /^(?:收尾|Closing)[：:]\s*(.*)$/s;
const LOCK_RE = /^🔒\s*/;
function emptyCard() {
  return { who: "", catchphrases: [], teaching_style: "", hard_rules: [], example_turns: [] };
}
function emptyProfile() {
  return { pace: "", preferences: [], stuck_points: [], effective_methods: [], misconceptions: [] };
}
function emptyStage(title) {
  return { title, method: "", must_memorize: [], self_checks: [], student_qa: [], pitfalls: [] };
}
function parseTutorDoc(text) {
  const normalized = (0, import_normalize.normalizeText)(text);
  const { yamlText, body } = (0, import_frontmatter.splitFrontmatter)(normalized);
  const { frontmatter, extra } = (0, import_frontmatter.parseFrontmatter)(yamlText);
  const warnings = [];
  const raw = { frontmatter: extra, notes: {}, leftovers: {}, subsections: [], sections: [] };
  const lines = body.split("\n");
  const labels = { head: null, tail: null };
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx >= 0 && import_constants.EXPLICIT_LABEL_RE.test(lines[firstIdx].trim())) {
    labels.head = lines[firstIdx].trim();
    lines.splice(firstIdx, 1);
  }
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx >= 0 && import_constants.EXPLICIT_LABEL_RE.test(lines[lastIdx].trim())) {
    labels.tail = lines[lastIdx].trim();
    lines.splice(lastIdx, 1);
  }
  const doc = {
    ...frontmatter,
    card: emptyCard(),
    profile: emptyProfile(),
    map: { stages: [], key_dates: [] },
    distill: {},
    log_excerpts: [],
    guide: { system_prompt: "", how_to_continue: "", how_to_update_profile: "", boundaries: "" },
    raw
  };
  const chunks = (0, import_markdown.splitByHeading)(lines, 2);
  const preamble = (0, import_markdown.parseBlockText)(chunks[0].lines);
  if (preamble) raw.sections.push({ after: "", heading: "", text: preamble });
  const seen = /* @__PURE__ */ new Set();
  let lastSection = "";
  for (const chunk of chunks.slice(1)) {
    const m = H2_RE.exec(chunk.heading.trim());
    const sec = m && import_constants.SECTIONS.find((s) => s.zh === m[2] || s.en.toLowerCase() === m[2].toLowerCase());
    if (!sec) {
      raw.sections.push({ after: lastSection, heading: chunk.heading.trim(), text: (0, import_markdown.parseBlockText)(chunk.lines) });
      continue;
    }
    if (seen.has(sec.key)) throw new import_frontmatter.FormatError(`\u300C${sec.zh}\u300D\u8FD9\u4E00\u6BB5\u51FA\u73B0\u4E86\u4E24\u6B21`);
    seen.add(sec.key);
    lastSection = sec.key;
    PARSERS[sec.key](chunk.lines, doc, raw, warnings);
  }
  for (const required of ["card", "map", "distill", "guide"]) {
    if (!seen.has(required)) {
      const s = import_constants.SECTIONS.find((x) => x.key === required);
      throw new import_frontmatter.FormatError(`\u7F3A\u5C11\u56FA\u5B9A\u6BB5\u843D\u300C${s.num} ${s.zh}\u300D\uFF08docs/03 \xA74\uFF09`);
    }
  }
  pruneEmpty(raw);
  if (Object.keys(raw).length === 0) delete doc.raw;
  return { doc, meta: { labels, computedChecksum: (0, import_checksum.bodyChecksum)(body), warnings } };
}
function pruneEmpty(raw) {
  if (raw.frontmatter && Object.keys(raw.frontmatter).length === 0) delete raw.frontmatter;
  if (raw.notes && Object.keys(raw.notes).length === 0) delete raw.notes;
  if (raw.leftovers && Object.keys(raw.leftovers).length === 0) delete raw.leftovers;
  if (raw.subsections && raw.subsections.length === 0) delete raw.subsections;
  if (raw.sections && raw.sections.length === 0) delete raw.sections;
}
function walkSubs(sectionKey, lines, subs, raw, onSub, onPreamble) {
  const chunks = (0, import_markdown.splitByHeading)(lines, 3);
  if (onPreamble) onPreamble(chunks[0].lines);
  else if ((0, import_markdown.parseBlockText)(chunks[0].lines)) raw.leftovers[`${sectionKey}._preamble`] = (0, import_markdown.parseBlockText)(chunks[0].lines);
  let after = null;
  for (const c of chunks.slice(1)) {
    const sub = (0, import_markdown.matchSub)(c.heading, subs);
    if (!sub) {
      raw.subsections.push({ section: sectionKey, after, heading: c.heading.trim(), text: (0, import_markdown.parseBlockText)(c.lines) });
      continue;
    }
    after = sub.key;
    const { note, rest } = (0, import_markdown.takeNote)(c.lines);
    if (note !== null) raw.notes[`${sectionKey}.${sub.key}`] = note;
    onSub(sub.key, rest);
  }
}
function keepLeftovers(raw, key, leftovers) {
  const text = leftovers.map((l) => l.replace(/\s+$/, "")).join("\n").trim();
  if (text) raw.leftovers[key] = text;
}
function parseCard(lines, doc, raw) {
  const card = doc.card;
  walkSubs("card", lines, import_constants.CARD_SUBS, raw, (key, rest) => {
    switch (key) {
      case "who":
        card.who = (0, import_markdown.parseBlockText)(rest);
        break;
      case "teaching_style":
        card.teaching_style = (0, import_markdown.parseBlockText)(rest);
        break;
      case "catchphrases": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        card.catchphrases = items;
        keepLeftovers(raw, "card.catchphrases", leftovers);
        break;
      }
      case "hard_rules": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        card.hard_rules = items.map((t) => {
          const locked = LOCK_RE.test(t);
          return { text: t.replace(LOCK_RE, ""), locked, from: locked ? "policy" : "author" };
        });
        keepLeftovers(raw, "card.hard_rules", leftovers);
        break;
      }
      case "greeting_closing": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        for (const it of items) {
          const g = GREETING_RE.exec(it);
          const c = CLOSING_RE.exec(it);
          if (g) card.greeting = g[1];
          else if (c) card.closing = c[1];
          else leftovers.push(`- ${it}`);
        }
        keepLeftovers(raw, "card.greeting_closing", leftovers);
        break;
      }
      case "example_turns": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        let pending = null;
        for (const it of items) {
          const t = TURN_RE.exec(it);
          if (!t) {
            leftovers.push(`- ${it}`);
            continue;
          }
          const role = /学生|Student/.test(t[1]) ? "student" : "teacher";
          if (role === "student") {
            if (pending) leftovers.push(`- **\u5B66\u751F**\uFF1A${pending}`);
            pending = t[2];
          } else if (pending !== null) {
            card.example_turns.push({ student: pending, teacher: t[2] });
            pending = null;
          } else leftovers.push(`- **\u8001\u5E08**\uFF1A${t[2]}`);
        }
        if (pending !== null) leftovers.push(`- **\u5B66\u751F**\uFF1A${pending}`);
        keepLeftovers(raw, "card.example_turns", leftovers);
        break;
      }
    }
  });
}
function parseStagedList(rest, raw, key, warnings) {
  const { items, leftovers } = (0, import_markdown.parseList)(rest);
  const out = [];
  for (const it of items) {
    const m = STAGED_ITEM_RE.exec(it);
    if (m) {
      const { text: body, meta } = splitMeta(m[2]);
      const { text, anchor } = splitAnchor(body);
      out.push({ stage_id: m[1], text, ...anchor ? { anchor } : {}, ...meta || {} });
    } else {
      leftovers.push(`- ${it}`);
      warnings.push(`${key}\uFF1A\u6761\u76EE\u300C${it.slice(0, 20)}\u2026\u300D\u7F3A [stage-NN] \u524D\u7F00\uFF0C\u5DF2\u539F\u6837\u4FDD\u7559\u4F46\u4E0D\u8FDB\u5B57\u6BB5`);
    }
  }
  keepLeftovers(raw, key, leftovers);
  return out;
}
function parseProfile(lines, doc, raw, warnings) {
  const p = doc.profile;
  walkSubs("profile", lines, import_constants.PROFILE_SUBS, raw, (key, rest) => {
    switch (key) {
      case "pace": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        p.pace = items.length ? items.join("\n") : (0, import_markdown.parseBlockText)(rest);
        if (items.length) keepLeftovers(raw, "profile.pace", leftovers);
        break;
      }
      case "preferences": {
        const { items, leftovers } = (0, import_markdown.parseList)(rest);
        p.preferences = items;
        keepLeftovers(raw, "profile.preferences", leftovers);
        break;
      }
      case "stuck_points":
        p.stuck_points = parseStagedList(rest, raw, "profile.stuck_points", warnings);
        break;
      case "effective_methods":
        p.effective_methods = parseStagedList(rest, raw, "profile.effective_methods", warnings);
        break;
      case "misconceptions":
        p.misconceptions = parseStagedList(rest, raw, "profile.misconceptions", warnings);
        break;
    }
  }, (pre) => {
    const { note, rest } = (0, import_markdown.takeNote)(pre);
    if (note !== null) raw.notes["profile"] = note;
    if ((0, import_markdown.parseBlockText)(rest)) raw.leftovers["profile._preamble"] = (0, import_markdown.parseBlockText)(rest);
  });
}
function parseMap(lines, doc, raw, warnings) {
  const map = doc.map;
  walkSubs("map", lines, import_constants.MAP_SUBS, raw, (key, rest) => {
    if (key === "key_dates") {
      const { items, leftovers } = (0, import_markdown.parseList)(rest);
      for (const it of items) {
        const parts = it.split(/\s*·\s*/);
        if (parts.length < 2) {
          leftovers.push(`- ${it}`);
          continue;
        }
        const [label, at, kind = "other"] = parts;
        if (!import_constants.KEY_DATE_KINDS.includes(kind)) warnings.push(`\u5173\u952E\u65E5\u671F\u300C${label}\u300D\u7684\u7C7B\u578B\u300C${kind}\u300D\u4E0D\u8BA4\u8BC6\uFF0C\u6309 other`);
        map.key_dates.push({ label, at, kind: import_constants.KEY_DATE_KINDS.includes(kind) ? kind : "other" });
      }
      keepLeftovers(raw, "map.key_dates", leftovers);
    } else if (key === "source_material_hashes") {
      const { items, leftovers } = (0, import_markdown.parseList)(rest);
      map.source_material_hashes = items.map((s) => s.replace(/^`|`$/g, ""));
      keepLeftovers(raw, "map.source_material_hashes", leftovers);
    }
  }, (pre) => {
    const { header, rows, leftovers } = (0, import_markdown.parseTable)(pre);
    if (!header) throw new import_frontmatter.FormatError("\u2462 \u8BFE\u7A0B\u5730\u56FE\u7F3A\u9636\u6BB5\u8868\uFF08\u8868\u5934 | \u5468 | \u9636\u6BB5 id | \u4E3B\u9898 | \u72B6\u6001 | \u5173\u952E\u65E5\u671F |\uFF09");
    const col = {};
    header.forEach((h, i) => {
      const c = import_constants.MAP_COLUMNS.find((x) => x.zh === h || x.en.toLowerCase() === h.toLowerCase());
      if (c) col[c.key] = i;
    });
    for (const need of ["stage_id", "title"]) {
      if (!(need in col)) throw new import_frontmatter.FormatError(`\u2462 \u9636\u6BB5\u8868\u7F3A\u300C${import_constants.MAP_COLUMNS.find((x) => x.key === need).zh}\u300D\u8FD9\u4E00\u5217`);
    }
    for (const r of rows) {
      const get = (k) => k in col ? (r[col[k]] ?? "").trim() : "";
      const weekRaw = get("week");
      const status = get("status") || "\u672A\u8BB2";
      if (!import_constants.STAGE_STATUS.includes(status)) throw new import_frontmatter.FormatError(`\u2462 \u9636\u6BB5 ${get("stage_id")} \u7684\u72B6\u6001\u300C${status}\u300D\u4E0D\u5728 ${import_constants.STAGE_STATUS.join(" / ")} \u4E4B\u5185`);
      map.stages.push({
        stage_id: get("stage_id"),
        week: /^\d+$/.test(weekRaw) ? Number(weekRaw) : weekRaw,
        title: get("title"),
        summary: get("summary"),
        status,
        key_date: get("key_date")
      });
    }
    keepLeftovers(raw, "map._preamble", leftovers);
  });
}
function parseDistill(lines, doc, raw, warnings) {
  const chunks = (0, import_markdown.splitByHeading)(lines, 3);
  if ((0, import_markdown.parseBlockText)(chunks[0].lines)) raw.leftovers["distill._preamble"] = (0, import_markdown.parseBlockText)(chunks[0].lines);
  let after = null;
  for (const c of chunks.slice(1)) {
    const m = STAGE_H3_RE.exec(c.heading.trim());
    if (!m) {
      raw.subsections.push({ section: "distill", after, heading: c.heading.trim(), text: (0, import_markdown.parseBlockText)(c.lines) });
      continue;
    }
    const [, stageId, title] = m;
    after = stageId;
    const st = emptyStage(title.trim());
    const rawLines = [];
    const subChunks = (0, import_markdown.splitByHeading)(c.lines, 4);
    if ((0, import_markdown.parseBlockText)(subChunks[0].lines)) rawLines.push((0, import_markdown.parseBlockText)(subChunks[0].lines));
    for (const sc of subChunks.slice(1)) {
      const sub = (0, import_markdown.matchSub)(sc.heading, import_constants.DISTILL_SUBS);
      if (!sub) {
        rawLines.push(`#### ${sc.heading.trim()}
${(0, import_markdown.parseBlockText)(sc.lines)}`);
        continue;
      }
      const { note, rest } = (0, import_markdown.takeNote)(sc.lines);
      if (note !== null) raw.notes[`distill.${stageId}.${sub.key}`] = note;
      switch (sub.key) {
        case "method":
          st.method = (0, import_markdown.parseBlockText)(rest);
          break;
        case "must_memorize": {
          const { items, leftovers } = (0, import_markdown.parseList)(rest);
          st.must_memorize = items.map(anchoredItem);
          rawLines.push(...leftovers);
          break;
        }
        case "pitfalls": {
          const { items, leftovers } = (0, import_markdown.parseList)(rest);
          st.pitfalls = items.map(anchoredItem);
          rawLines.push(...leftovers);
          break;
        }
        case "walkthrough": {
          const { items, leftovers } = (0, import_markdown.parseList)(rest);
          rawLines.push(...leftovers);
          st.walkthrough = items.map((it) => {
            const { text, anchor } = splitAnchor(it);
            const w = WALK_RE.exec(text);
            const step = { say: (w?.[1] ?? text).trim() };
            if (w?.[2]) step.ask = w[2].trim();
            if (anchor) step.anchor = anchor;
            return step;
          });
          break;
        }
        case "self_checks": {
          const { items, leftovers } = (0, import_markdown.parseList)(rest);
          rawLines.push(...leftovers);
          for (const it of items) {
            const { text: body, anchor } = splitAnchor(it);
            const q = SELF_CHECK_RE.exec(body);
            if (!q) {
              rawLines.push(`- ${it}`);
              warnings.push(`\u2463 ${stageId} \u81EA\u68C0\u9898\u300C${it.slice(0, 24)}\u2026\u300D\u4E0D\u5408\u56FA\u5B9A\u5199\u6CD5\uFF0C\u539F\u6837\u4FDD\u7559\u8FDB raw`);
              continue;
            }
            const sc2 = { q: q[1], a: q[2], kind: import_constants.SELF_CHECK_KINDS[q[3]] };
            if (q[4]) sc2.rubric = q[4];
            if (anchor) sc2.anchor = anchor;
            st.self_checks.push(sc2);
          }
          break;
        }
        case "student_qa": {
          const { items, leftovers } = (0, import_markdown.parseList)(rest);
          rawLines.push(...leftovers);
          for (const it of items) {
            const { text: body, anchor } = splitAnchor(it);
            const q = STUDENT_QA_RE.exec(body);
            if (!q) {
              rawLines.push(`- ${it}`);
              warnings.push(`\u2463 ${stageId} \u5B66\u751F\u95EE\u7B54\u300C${it.slice(0, 24)}\u2026\u300D\u4E0D\u5408\u56FA\u5B9A\u5199\u6CD5\uFF0C\u539F\u6837\u4FDD\u7559\u8FDB raw`);
              continue;
            }
            const qa = { q: q[1], a: q[2] };
            if (q[3]) qa.from_turn = Number(q[3]);
            if (anchor) qa.anchor = anchor;
            st.student_qa.push(qa);
          }
          break;
        }
      }
    }
    if (rawLines.length) st.raw = rawLines;
    if (doc.distill[stageId]) throw new import_frontmatter.FormatError(`\u2463 \u91CC ${stageId} \u51FA\u73B0\u4E86\u4E24\u6B21`);
    doc.distill[stageId] = st;
  }
}
function parseLog(lines, doc, raw) {
  const chunks = (0, import_markdown.splitByHeading)(lines, 3);
  const { note, rest } = (0, import_markdown.takeNote)(chunks[0].lines);
  if (note !== null) raw.notes["log"] = note;
  if ((0, import_markdown.parseBlockText)(rest)) raw.leftovers["log._preamble"] = (0, import_markdown.parseBlockText)(rest);
  let after = null;
  for (const c of chunks.slice(1)) {
    const m = LOG_H3_RE.exec(c.heading.trim());
    if (!m) {
      raw.subsections.push({ section: "log", after, heading: c.heading.trim(), text: (0, import_markdown.parseBlockText)(c.lines) });
      continue;
    }
    const ex = { stage_id: m[1], why: (m[4] || "").trim(), turns: [] };
    if (m[2]) {
      ex.turn_from = Number(m[2]);
      ex.turn_to = Number(m[3]);
    }
    after = `${ex.stage_id}:${ex.turn_from ?? ""}`;
    const { items, leftovers } = (0, import_markdown.parseList)(c.lines);
    for (const it of items) {
      const t = TURN_RE.exec(it);
      if (!t) {
        leftovers.push(`- ${it}`);
        continue;
      }
      ex.turns.push({ role: /学生|Student/.test(t[1]) ? "student" : "teacher", text: t[2] });
    }
    keepLeftovers(raw, `log.${after}`, leftovers);
    doc.log_excerpts.push(ex);
  }
}
function parseGuide(lines, doc, raw) {
  walkSubs("guide", lines, import_constants.GUIDE_SUBS, raw, (key, rest) => {
    doc.guide[key] = (0, import_markdown.parseBlockText)(rest);
  });
}
const PARSERS = { card: parseCard, profile: parseProfile, map: parseMap, distill: parseDistill, log: parseLog, guide: parseGuide };
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseTutorDoc
});
