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
var referral_exports = {};
__export(referral_exports, {
  FORK_ACTIVATION_DAYS: () => FORK_ACTIVATION_DAYS,
  METRICS_WINDOW_DAYS: () => METRICS_WINDOW_DAYS,
  REFERRAL_FROM: () => REFERRAL_FROM,
  REFERRAL_TTL_DAYS: () => REFERRAL_TTL_DAYS,
  forkActivated: () => forkActivated,
  normalizeFrom: () => normalizeFrom,
  normalizePath: () => normalizePath,
  ratioOf: () => ratioOf,
  referralDay: () => referralDay
});
module.exports = __toCommonJS(referral_exports);
const REFERRAL_FROM = [
  "nav",
  // 官网顶栏 🎓
  "download",
  // 官网 /download 第三张卡「启梦老师（网页版）」
  "settings",
  // 官网设置页「页面」区
  "tour",
  // 官网新手引导 homeFeed 那一步
  "persona",
  // 官网人格详情页「把这个人格拿去当老师」
  "gallery",
  // 官网人格广场顶部那一行
  "preview",
  // 官网 /v/:id 站外预览页播完弹层
  "app-settings",
  // App 设置页「AI 老师（网页版）」
  "app-create"
  // App 创作中心第四扇门「人物 → 老师」
];
const REFERRAL_TTL_DAYS = 90;
const METRICS_WINDOW_DAYS = 30;
const FORK_ACTIVATION_DAYS = 7;
function normalizeFrom(v) {
  const s = String(v ?? "").trim().toLowerCase().slice(0, 40);
  return REFERRAL_FROM.includes(s) ? s : null;
}
function normalizePath(v) {
  const s = String(v ?? "").trim().slice(0, 120);
  return /^\/[^\s]*$/.test(s) && !s.startsWith("//") ? s : "/tutor";
}
function referralDay(d = /* @__PURE__ */ new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}
const ratioOf = (a, b) => b > 0 ? Math.round(a / b * 1e3) / 1e3 : 0;
function forkActivated(progress, forkedAt, days = FORK_ACTIVATION_DAYS) {
  const t0 = new Date(forkedAt || 0).getTime();
  if (!t0) return false;
  const t1 = t0 + days * 864e5;
  return Object.values(progress || {}).some((p) => p && p.status === "passed" && p.passedAt && (() => {
    const t = new Date(p.passedAt).getTime();
    return t >= t0 && t <= t1;
  })());
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FORK_ACTIVATION_DAYS,
  METRICS_WINDOW_DAYS,
  REFERRAL_FROM,
  REFERRAL_TTL_DAYS,
  forkActivated,
  normalizeFrom,
  normalizePath,
  ratioOf,
  referralDay
});
