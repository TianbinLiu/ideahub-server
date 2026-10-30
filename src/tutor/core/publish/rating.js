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
var rating_exports = {};
__export(rating_exports, {
  RATE_REASONS: () => RATE_REASONS,
  RATING_MAX: () => RATING_MAX,
  RATING_MIN: () => RATING_MIN,
  RATING_MIN_VOTES: () => RATING_MIN_VOTES,
  RATING_TEXT_MAX: () => RATING_TEXT_MAX,
  canRate: () => canRate,
  emptyDist: () => emptyDist,
  normalizeRating: () => normalizeRating,
  ratingSummary: () => ratingSummary,
  summaryFromDist: () => summaryFromDist
});
module.exports = __toCommonJS(rating_exports);
const RATING_MIN = 1;
const RATING_MAX = 5;
const RATING_TEXT_MAX = 500;
const RATING_MIN_VOTES = 3;
const RATE_REASONS = {
  owner: "\u81EA\u5DF1\u7684\u8001\u5E08\u4E0D\u80FD\u8BC4",
  blocked: "\u4F60\u4EEC\u4E4B\u95F4\u6709\u62C9\u9ED1\uFF0C\u4E0D\u80FD\u8BC4",
  notStarted: "\u5148\u300C\u5F00\u59CB\u8DDF\u8FD9\u4F4D\u8001\u5E08\u5B66\u300D\uFF0C\u901A\u8FC7\u81F3\u5C11\u4E00\u4E2A\u9636\u6BB5\u7684\u81EA\u68C0\u540E\u624D\u80FD\u8BC4\u5206",
  noneDone: "\u8FD8\u6CA1\u6709\u901A\u8FC7\u4EFB\u4F55\u4E00\u4E2A\u9636\u6BB5\u7684\u81EA\u68C0 \u2014\u2014 \u5B66\u5B8C\u4E00\u6BB5\u518D\u6765\u8BC4\uFF08\u8BC4\u5206\u524D\u7F6E\uFF1A\u5B8C\u6210\u8FC7\u81F3\u5C11\u4E00\u4E2A session\uFF09"
};
function canRate({ isOwner = false, blocked = false, progress = null, runStatus = null } = {}) {
  if (isOwner) return { ok: false, reason: "owner", message: RATE_REASONS.owner };
  if (blocked) return { ok: false, reason: "blocked", message: RATE_REASONS.blocked };
  if (!progress || typeof progress !== "object") return { ok: false, reason: "notStarted", message: RATE_REASONS.notStarted };
  const done = runStatus === "done" || Object.values(progress).some((p) => p && p.status === "passed");
  if (!done) return { ok: false, reason: "noneDone", message: RATE_REASONS.noneDone };
  return { ok: true };
}
function normalizeRating(body = {}) {
  const stars = Number(body && body.stars);
  if (!Number.isInteger(stars) || stars < RATING_MIN || stars > RATING_MAX) return { error: `stars \u8981\u662F ${RATING_MIN}~${RATING_MAX} \u7684\u6574\u6570` };
  const text = String((body && body.text) ?? "").trim();
  if (text.length > RATING_TEXT_MAX) return { error: `\u8BC4\u8BED\u6700\u591A ${RATING_TEXT_MAX} \u5B57\uFF08\u7ED9\u4E86 ${text.length}\uFF09` };
  return { stars, text };
}
const emptyDist = () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
function summaryFromDist(dist = {}) {
  const d = emptyDist();
  for (const k of Object.keys(d)) d[k] = Math.max(0, Number(dist[k]) || 0);
  const count = Object.values(d).reduce((a, b) => a + b, 0);
  const sum = Object.entries(d).reduce((a, [k, n]) => a + Number(k) * n, 0);
  return { avg: count ? Math.round(sum / count * 100) / 100 : 0, count, dist: d };
}
function ratingSummary(rows = []) {
  const d = emptyDist();
  for (const r of rows) if (r && d[r.stars] !== void 0) d[r.stars] += 1;
  return summaryFromDist(d);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RATE_REASONS,
  RATING_MAX,
  RATING_MIN,
  RATING_MIN_VOTES,
  RATING_TEXT_MAX,
  canRate,
  emptyDist,
  normalizeRating,
  ratingSummary,
  summaryFromDist
});
