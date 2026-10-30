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
var scrubPii_exports = {};
__export(scrubPii_exports, {
  PII_MASK: () => PII_MASK,
  isNonPersonalIp: () => isNonPersonalIp,
  scrubDeep: () => scrubDeep,
  scrubPii: () => scrubPii
});
module.exports = __toCommonJS(scrubPii_exports);
const PHONE_RE = /(?<![\d])1[3-9]\d{9}(?![\d])/g;
const ID_CARD_RE = /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IPV4_RE = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g;
function isNonPersonalIp(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && ip.startsWith("192.0.2.")) return true;
  if (a === 198 && b === 51 && ip.startsWith("198.51.100.")) return true;
  if (a === 203 && b === 0 && ip.startsWith("203.0.113.")) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}
const PII_MASK = "***";
function scrubPii(text) {
  if (typeof text !== "string") return { text, hits: [] };
  const hits = [];
  let out = text.replace(EMAIL_RE, () => {
    hits.push("email");
    return PII_MASK;
  });
  out = out.replace(ID_CARD_RE, () => {
    hits.push("id_card");
    return PII_MASK;
  });
  out = out.replace(PHONE_RE, () => {
    hits.push("phone");
    return PII_MASK;
  });
  out = out.replace(IPV4_RE, (ip) => {
    if (isNonPersonalIp(ip)) return ip;
    hits.push("ipv4");
    return PII_MASK;
  });
  return { text: out, hits };
}
function scrubDeep(value, hits = []) {
  if (typeof value === "string") {
    const r = scrubPii(value);
    hits.push(...r.hits);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, hits));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, hits)]));
  return value;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PII_MASK,
  isNonPersonalIp,
  scrubDeep,
  scrubPii
});
