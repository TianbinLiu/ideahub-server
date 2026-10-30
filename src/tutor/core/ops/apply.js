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
var apply_exports = {};
__export(apply_exports, {
  applyOne: () => applyOne,
  applyOps: () => applyOps,
  revertOne: () => revertOne
});
module.exports = __toCommonJS(apply_exports);
var import_catalog = require("./catalog.js");
const clone = (v) => JSON.parse(JSON.stringify(v));
function nextStageId(stages) {
  const max = stages.reduce((m, s) => Math.max(m, Number(s.stage_id.slice(6))), 0);
  return `stage-${String(max + 1).padStart(2, "0")}`;
}
function ensureStage(doc, stageId) {
  if (!doc.distill[stageId]) {
    const st = doc.map.stages.find((s) => s.stage_id === stageId);
    doc.distill[stageId] = { title: st?.title ?? "", method: "", must_memorize: [], self_checks: [], student_qa: [], pitfalls: [] };
  }
  return doc.distill[stageId];
}
const sameStaged = (a, b) => a.stage_id === b.stage_id && a.text === b.text;
const sameQa = (a, b) => a.q === b.q && a.a === b.a;
const textOf = (x) => typeof x === "string" ? x : x.text;
const withAnchor = (text, op) => op.anchor ? { text, anchor: op.anchor } : text;
function applyOne(doc, op, now = (/* @__PURE__ */ new Date()).toISOString()) {
  const spec = import_catalog.OP_CATALOG[op.op];
  const stage = spec.scope === "stage" ? spec.path.exec(op.path)[1] : null;
  const p = doc.profile;
  switch (op.op) {
    case "profile.pace.set": {
      const prev = p.pace;
      p.pace = op.value;
      return { prev };
    }
    case "profile.preference.add":
      if (p.preferences.includes(op.value)) return { noop: true };
      p.preferences.push(op.value);
      return {};
    case "profile.preference.remove": {
      const i = p.preferences.indexOf(op.value);
      if (i < 0) return { noop: true };
      p.preferences.splice(i, 1);
      return { prev: op.value };
    }
    case "profile.stuck_point.add": {
      const hit = p.stuck_points.find((x) => sameStaged(x, op.value));
      if (hit) {
        hit.last_seen = now;
        hit.evidence = [.../* @__PURE__ */ new Set([...hit.evidence || [], ...op.evidence])];
        if (op.anchor && !hit.anchor) hit.anchor = op.anchor;
        return { noop: true };
      }
      p.stuck_points.push({ ...op.value, ...op.anchor ? { anchor: op.anchor } : {}, first_seen: now, last_seen: now, evidence: [...op.evidence] });
      return {};
    }
    case "profile.stuck_point.resolve": {
      const hit = p.stuck_points.find((x) => sameStaged(x, op.value) || x.stage_id === op.value.stage_id && !op.value.text);
      if (!hit || hit.resolved_at) return { noop: true };
      hit.resolved_at = now;
      return { prev: void 0 };
    }
    case "profile.misconception.add":
      if (p.misconceptions.some((x) => sameStaged(x, op.value))) return { noop: true };
      p.misconceptions.push({ ...op.value, ...op.anchor ? { anchor: op.anchor } : {}, evidence: [...op.evidence] });
      return {};
    case "profile.effective_method.add":
      if (p.effective_methods.some((x) => sameStaged(x, op.value))) return { noop: true };
      p.effective_methods.push({ ...op.value, ...op.anchor ? { anchor: op.anchor } : {}, evidence: [...op.evidence] });
      return {};
    case "distill.pitfall.add": {
      const st = ensureStage(doc, stage);
      if (st.pitfalls.some((x) => textOf(x) === op.value)) return { noop: true };
      st.pitfalls.push(withAnchor(op.value, op));
      return {};
    }
    case "distill.must_memorize.add": {
      const st = ensureStage(doc, stage);
      if (st.must_memorize.some((x) => textOf(x) === op.value)) return { noop: true };
      st.must_memorize.push(withAnchor(op.value, op));
      return {};
    }
    case "distill.self_check.add": {
      const st = ensureStage(doc, stage);
      if (st.self_checks.some((x) => sameQa(x, op.value))) return { noop: true };
      st.self_checks.push({ ...clone(op.value), ...op.anchor ? { anchor: op.anchor } : {} });
      return {};
    }
    case "distill.student_qa.add": {
      const st = ensureStage(doc, stage);
      if (st.student_qa.some((x) => sameQa(x, op.value))) return { noop: true };
      st.student_qa.push({ ...clone(op.value), ...op.anchor ? { anchor: op.anchor } : {} });
      return {};
    }
    case "distill.step.add": {
      const st = ensureStage(doc, stage);
      st.walkthrough = st.walkthrough || [];
      if (st.walkthrough.some((w) => w.say === op.value.say)) return { noop: true };
      const step = { say: op.value.say };
      if (op.value.ask) step.ask = op.value.ask;
      const anchor = op.value.anchor || op.anchor;
      if (anchor) step.anchor = anchor;
      st.walkthrough.push(step);
      return {};
    }
    case "distill.method.replace": {
      const st = ensureStage(doc, stage);
      const prev = st.method;
      st.method = op.value;
      return { prev };
    }
    case "card.style.adjust": {
      const field = /tone$/.test(op.path) ? "tone" : "teaching_style";
      const prev = doc.card[field];
      doc.card[field] = op.value;
      return { prev };
    }
    case "card.catchphrase.add":
      if (doc.card.catchphrases.includes(op.value)) return { noop: true };
      doc.card.catchphrases.push(op.value);
      return {};
    case "map.stage.propose": {
      const id = nextStageId(doc.map.stages);
      doc.map.stages.push({ stage_id: id, week: op.value.week, title: op.value.title, summary: op.value.summary || "", status: "\u672A\u8BB2", key_date: op.value.key_date || "" });
      doc.stages = doc.map.stages.length;
      if (op.value.distill) {
        const st = ensureStage(doc, id);
        const d = op.value.distill;
        const strip = (x) => typeof x === "string" ? x : x.anchor ? { text: x.text, anchor: x.anchor } : x.text;
        Object.assign(st, { method: d.method || "", must_memorize: (d.must_memorize || []).map(strip), self_checks: d.self_checks || [], pitfalls: (d.pitfalls || []).map(strip) });
        if (d.walkthrough?.length) st.walkthrough = d.walkthrough.map((w) => {
          const s = { say: w.say };
          if (w.ask) s.ask = w.ask;
          if (w.anchor) s.anchor = w.anchor;
          return s;
        });
      }
      return { created: id };
    }
    default:
      throw new Error(`applyOne\uFF1A\u76EE\u5F55\u91CC\u6709\u4F46\u8FD9\u91CC\u6CA1\u5B9E\u73B0\u7684 op\u300C${op.op}\u300D\u2014\u2014 \u52A0 op \u8981\u4E24\u5904\u4E00\u8D77\u52A0`);
  }
}
function revertOne(doc, applied) {
  const { op, value, path, prev, created } = applied;
  const spec = import_catalog.OP_CATALOG[op];
  const stage = spec.scope === "stage" ? spec.path.exec(path)[1] : null;
  const p = doc.profile;
  const dropStaged = (arr) => {
    const i = arr.findIndex((x) => x.stage_id === value.stage_id && x.text === value.text);
    if (i >= 0) arr.splice(i, 1);
  };
  const drop = (arr, v) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  };
  switch (op) {
    case "profile.pace.set":
      p.pace = prev ?? "";
      break;
    case "profile.preference.add":
      drop(p.preferences, value);
      break;
    case "profile.preference.remove":
      if (prev !== void 0 && !p.preferences.includes(prev)) p.preferences.push(prev);
      break;
    case "profile.stuck_point.add":
      dropStaged(p.stuck_points);
      break;
    case "profile.stuck_point.resolve": {
      const hit = p.stuck_points.find((x) => x.stage_id === value.stage_id && x.text === value.text);
      if (hit) delete hit.resolved_at;
      break;
    }
    case "profile.misconception.add":
      dropStaged(p.misconceptions);
      break;
    case "profile.effective_method.add":
      dropStaged(p.effective_methods);
      break;
    case "distill.pitfall.add": {
      const arr = doc.distill[stage]?.pitfalls || [];
      const i = arr.findIndex((x) => textOf(x) === value);
      if (i >= 0) arr.splice(i, 1);
      break;
    }
    case "distill.must_memorize.add": {
      const arr = doc.distill[stage]?.must_memorize || [];
      const i = arr.findIndex((x) => textOf(x) === value);
      if (i >= 0) arr.splice(i, 1);
      break;
    }
    case "distill.step.add": {
      const arr = doc.distill[stage]?.walkthrough || [];
      const i = arr.findIndex((w) => w.say === value.say);
      if (i >= 0) arr.splice(i, 1);
      break;
    }
    case "distill.self_check.add": {
      const arr = doc.distill[stage]?.self_checks || [];
      const i = arr.findIndex((x) => x.q === value.q && x.a === value.a);
      if (i >= 0) arr.splice(i, 1);
      break;
    }
    case "distill.student_qa.add": {
      const arr = doc.distill[stage]?.student_qa || [];
      const i = arr.findIndex((x) => x.q === value.q && x.a === value.a);
      if (i >= 0) arr.splice(i, 1);
      break;
    }
    case "distill.method.replace":
      if (doc.distill[stage]) doc.distill[stage].method = prev ?? "";
      break;
    case "card.style.adjust":
      doc.card[/tone$/.test(path) ? "tone" : "teaching_style"] = prev ?? "";
      break;
    case "card.catchphrase.add":
      drop(doc.card.catchphrases, value);
      break;
    case "map.stage.propose": {
      const i = doc.map.stages.findIndex((s) => s.stage_id === created);
      if (i >= 0) doc.map.stages.splice(i, 1);
      delete doc.distill[created];
      doc.stages = doc.map.stages.length;
      break;
    }
    default:
      throw new Error(`revertOne\uFF1A\u6CA1\u5B9E\u73B0\u7684 op\u300C${op}\u300D`);
  }
}
async function applyOps(doc, ops, opts = {}) {
  const next = clone(doc);
  const applied = opts.appliedIds || /* @__PURE__ */ new Set();
  const results = [];
  for (const op of ops) {
    if (applied.has(op.opId)) {
      results.push({ ...op, status: "skipped" });
      continue;
    }
    if (op.mode === "pending") {
      if (!opts.confirm) {
        results.push({ ...op, status: "pending" });
        continue;
      }
      if (!await opts.confirm(op)) {
        results.push({ ...op, status: "rejected" });
        continue;
      }
    }
    const r = applyOne(next, op);
    results.push({ ...op, status: r.noop ? "noop" : "applied", prev: r.prev, created: r.created });
  }
  return { doc: next, results };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyOne,
  applyOps,
  revertOne
});
