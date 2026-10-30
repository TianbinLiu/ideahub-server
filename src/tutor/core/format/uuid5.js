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
var uuid5_exports = {};
__export(uuid5_exports, {
  uuidv5: () => uuidv5
});
module.exports = __toCommonJS(uuid5_exports);
var import_node_crypto = require("node:crypto");
function uuidv5(namespace, name) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error("uuidv5\uFF1Anamespace \u5FC5\u987B\u662F UUID");
  const h = (0, import_node_crypto.createHash)("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  h[6] = h[6] & 15 | 80;
  h[8] = h[8] & 63 | 128;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  uuidv5
});
