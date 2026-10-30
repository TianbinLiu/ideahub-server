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
var json_exports = {};
__export(json_exports, {
  fromJsonMirror: () => fromJsonMirror,
  toJsonMirror: () => toJsonMirror
});
module.exports = __toCommonJS(json_exports);
var import_schema = require("./schema.js");
var import_frontmatter = require("./frontmatter.js");
function toJsonMirror(doc) {
  const { profile, ...rest } = doc;
  const key = doc.audience === "market" ? "profile_seed" : "profile";
  return { ...rest, [key]: profile };
}
function fromJsonMirror(json) {
  const obj = typeof json === "string" ? JSON.parse(json) : json;
  const { profile_seed, profile, ...rest } = obj;
  const doc = { ...rest, profile: profile ?? profile_seed ?? { pace: "", preferences: [], stuck_points: [], effective_methods: [], misconceptions: [] } };
  const res = import_schema.TutorDocSchema.safeParse(doc);
  if (!res.success) {
    const lines = (0, import_schema.issuesToLines)(res.error.issues);
    throw new import_frontmatter.FormatError(`persona.json \u4E0D\u5408\u89C4\u8303\uFF1A
  ${lines.join("\n  ")}`, lines);
  }
  return res.data;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  fromJsonMirror,
  toJsonMirror
});
