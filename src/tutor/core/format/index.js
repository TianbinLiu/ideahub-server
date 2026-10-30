var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var format_exports = {};
__export(format_exports, {
  FormatError: () => import_frontmatter.FormatError,
  bodyChecksum: () => import_checksum.bodyChecksum,
  canonicalBody: () => import_normalize.canonicalBody,
  checkFormatVersion: () => import_frontmatter.checkFormatVersion,
  constants: () => constants,
  expectedProduceId: () => import_validate.expectedProduceId,
  fromJsonMirror: () => import_json.fromJsonMirror,
  normalizeText: () => import_normalize.normalizeText,
  parseFrontmatter: () => import_frontmatter.parseFrontmatter,
  parseTutorDoc: () => import_parse.parseTutorDoc,
  renderFrontmatter: () => import_frontmatter.renderFrontmatter,
  renderTutorDoc: () => import_render.renderTutorDoc,
  sha256Hex: () => import_checksum.sha256Hex,
  splitFrontmatter: () => import_frontmatter.splitFrontmatter,
  stripSections: () => import_render.stripSections,
  toJsonMirror: () => import_json.toJsonMirror,
  uuidv5: () => import_uuid5.uuidv5,
  validateTutorDoc: () => import_validate.validateTutorDoc
});
module.exports = __toCommonJS(format_exports);
var import_parse = require("./parse.js");
var import_render = require("./render.js");
var import_validate = require("./validate.js");
var import_uuid5 = require("./uuid5.js");
var import_checksum = require("./checksum.js");
var import_normalize = require("./normalize.js");
var import_frontmatter = require("./frontmatter.js");
var import_json = require("./json.js");
var constants = __toESM(require("./constants.js"), 1);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FormatError,
  bodyChecksum,
  canonicalBody,
  checkFormatVersion,
  constants,
  expectedProduceId,
  fromJsonMirror,
  normalizeText,
  parseFrontmatter,
  parseTutorDoc,
  renderFrontmatter,
  renderTutorDoc,
  sha256Hex,
  splitFrontmatter,
  stripSections,
  toJsonMirror,
  uuidv5,
  validateTutorDoc
});
