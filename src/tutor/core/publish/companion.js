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
var companion_exports = {};
__export(companion_exports, {
  COMPANION_STYLE_LIMITS: () => COMPANION_STYLE_LIMITS,
  companionOptIn: () => companionOptIn,
  companionStyleOf: () => companionStyleOf
});
module.exports = __toCommonJS(companion_exports);
const COMPANION_STYLE_LIMITS = {
  summary: 2e3,
  catchphrases: { count: 12, each: 120 },
  tone: 300,
  addressUser: 60,
  greeting: 300,
  examples: { count: 12, each: 300 },
  boundaries: { count: 12, each: 120 }
};
const companionOptIn = (body) => !!body && body.alsoCompanion === true;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
function strList(arr, { count, each }, pick = (x) => x) {
  const out = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = clip(pick(x), each);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= count) break;
  }
  return out;
}
function companionStyleOf(card) {
  const c = card || {};
  const L = COMPANION_STYLE_LIMITS;
  const summary = clip([c.who, c.teaching_style].map((x) => String(x ?? "").trim()).filter(Boolean).join("\n"), L.summary);
  const examples = [];
  for (const t of Array.isArray(c.example_turns) ? c.example_turns : []) {
    const user = clip(t?.student, L.examples.each);
    const reply = clip(t?.teacher, L.examples.each);
    if (user && reply) examples.push({ user, reply });
    if (examples.length >= L.examples.count) break;
  }
  return {
    summary,
    catchphrases: strList(c.catchphrases, L.catchphrases),
    tone: clip(c.tone, L.tone),
    addressUser: clip(c.address_student, L.addressUser),
    greeting: clip(c.greeting, L.greeting),
    examples,
    boundaries: strList(c.hard_rules, L.boundaries, (r) => typeof r === "string" ? r : r?.text)
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMPANION_STYLE_LIMITS,
  companionOptIn,
  companionStyleOf
});
