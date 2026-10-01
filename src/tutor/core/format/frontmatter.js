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
var frontmatter_exports = {};
__export(frontmatter_exports, {
  FRONTMATTER_ORDER: () => FRONTMATTER_ORDER,
  FormatError: () => FormatError,
  checkFormatVersion: () => checkFormatVersion,
  parseFrontmatter: () => parseFrontmatter,
  renderFrontmatter: () => renderFrontmatter,
  splitFrontmatter: () => splitFrontmatter
});
module.exports = __toCommonJS(frontmatter_exports);
var import_js_yaml = require("js-yaml");
var import_schema = require("./schema.js");
var import_constants = require("./constants.js");
class FormatError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "FormatError";
    this.details = details;
  }
}
const FRONTMATTER_ORDER = [
  "format",
  "id",
  "version",
  "supersedes",
  "superseded_by",
  "version_note",
  "name",
  "subject",
  "course",
  "language",
  "tags",
  "author",
  "license",
  "policy",
  "includes_student_profile",
  "includes_dialogue_log",
  "stages",
  "fork_of",
  "AIGC",
  "provenance",
  "exported_at",
  "audience",
  "checksum",
  "deprecated_since"
];
const FLOW_KEYS = /* @__PURE__ */ new Set(["course", "tags", "author", "license", "fork_of"]);
function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    throw new FormatError("\u6587\u4EF6\u5FC5\u987B\u4EE5\u4E00\u884C `---` \u5F00\u5934\u7684 YAML frontmatter \u8D77\u624B\uFF08docs/03 \xA72\uFF09");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) {
    if (text.endsWith("\n---")) return { yamlText: text.slice(4, -4), body: "" };
    throw new FormatError("frontmatter \u6CA1\u6709\u95ED\u5408\u7684 `---` \u884C");
  }
  return { yamlText: text.slice(4, end + 1), body: text.slice(end + 5) };
}
function parseFrontmatter(yamlText) {
  let raw;
  try {
    raw = (0, import_js_yaml.load)(yamlText, { schema: import_js_yaml.CORE_SCHEMA });
  } catch (e) {
    throw new FormatError(`frontmatter \u4E0D\u662F\u5408\u6CD5 YAML\uFF1A${e.message.split("\n")[0]}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FormatError("frontmatter \u5FC5\u987B\u662F\u4E00\u4E2A\u952E\u503C\u6620\u5C04");
  }
  checkFormatVersion(raw.format);
  const known = {};
  const extra = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FRONTMATTER_ORDER.includes(k)) known[k] = v;
    else extra[k] = v;
  }
  const res = import_schema.FrontmatterSchema.safeParse(known);
  if (!res.success) {
    const lines = (0, import_schema.issuesToLines)(res.error.issues);
    throw new FormatError(`frontmatter \u4E0D\u5408\u89C4\u8303\uFF1A
  ${lines.join("\n  ")}`, lines);
  }
  return { frontmatter: res.data, extra };
}
function checkFormatVersion(format) {
  if (typeof format !== "string") throw new FormatError("frontmatter \u7F3A `format`\uFF08\u4F8B\u5982 ideahub-tutor/1.0\uFF09");
  const m = /^([a-z][a-z0-9-]*)\/(\d+)\.(\d+)$/.exec(format);
  if (!m) throw new FormatError(`format \u5199\u6CD5\u4E0D\u5BF9\uFF1A\u300C${format}\u300D\uFF0C\u5E94\u4E3A \u540D\u5B57/\u4E3B.\u6B21`);
  if (m[1] !== import_constants.FORMAT_NAME) throw new FormatError(`\u8FD9\u4E0D\u662F ${import_constants.FORMAT_NAME} \u7684\u6587\u4EF6\uFF08format=${format}\uFF09`);
  const major = Number(m[2]);
  if (major !== import_constants.FORMAT_MAJOR) {
    throw new FormatError(`\u8FD9\u4EFD\u6587\u4EF6\u662F ${import_constants.FORMAT_NAME}/${major}\uFF0C\u672C\u8BFB\u8005\u53EA\u8BA4 ${import_constants.FORMAT_MAJOR}.x\uFF0C\u8BF7\u5347\u7EA7\u8BFB\u8005\u6216\u7528 migrate \u8F6C\u6362`);
  }
  return { major, minor: Number(m[3]), newerMinor: Number(m[3]) > import_constants.FORMAT_MINOR };
}
function dumpFlow(value) {
  return (0, import_js_yaml.dump)(value, { schema: import_js_yaml.CORE_SCHEMA, flowLevel: 0, lineWidth: -1, noRefs: true }).trimEnd();
}
function dumpBlock(key, value) {
  return (0, import_js_yaml.dump)({ [key]: value }, { schema: import_js_yaml.CORE_SCHEMA, lineWidth: -1, noRefs: true, quotingType: '"' }).trimEnd();
}
function renderFrontmatter(frontmatter, extra = {}) {
  const lines = [];
  for (const key of FRONTMATTER_ORDER) {
    if (!(key in frontmatter) || frontmatter[key] === void 0) continue;
    const v = frontmatter[key];
    if (FLOW_KEYS.has(key) && v !== null && typeof v === "object") lines.push(`${key}: ${dumpFlow(v)}`);
    else lines.push(dumpBlock(key, v));
  }
  for (const [key, v] of Object.entries(extra)) lines.push(dumpBlock(key, v));
  return lines.join("\n") + "\n";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FRONTMATTER_ORDER,
  FormatError,
  checkFormatVersion,
  parseFrontmatter,
  renderFrontmatter,
  splitFrontmatter
});
