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
var checksum_exports = {};
__export(checksum_exports, {
  bodyChecksum: () => bodyChecksum,
  sha256Hex: () => sha256Hex
});
module.exports = __toCommonJS(checksum_exports);
var import_node_crypto = require("node:crypto");
var import_normalize = require("./normalize.js");
function bodyChecksum(body) {
  const hex = (0, import_node_crypto.createHash)("sha256").update((0, import_normalize.canonicalBody)(body), "utf8").digest("hex");
  return `sha256:${hex}`;
}
function sha256Hex(bufOrStr) {
  return (0, import_node_crypto.createHash)("sha256").update(bufOrStr).digest("hex");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bodyChecksum,
  sha256Hex
});
