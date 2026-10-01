"use strict";
/**
 * 老师人格的评分（tutor 仓 docs/02 §9.6、docs/05 §3 TutorRating、docs/06 §4.1）：全站第一张 1~5 星表。
 * ★ 规则（能不能评 / 形状 / 均分怎么算 / 沉底票数）全在核心包 core/publish/rating（tutor 仓 src/publish/rating.js，参考实现同一份）；这里只管查库、存、回写。
 * ★ 前置「完成过至少一个 session」= 这个人从这位老师开出的课（TutorCourse{owner, sourcePersona}）的 run 至少一个阶段 passed 或整门 done。
 * ★ ratingAvg / ratingCount 从 TutorRating 按星 aggregate 后**重算**回写，不 $inc（BranchAssetLike.js 头上的理由）。
 * ★ 一人一票可改（{user, persona} 唯一）：第一次评才通知作者，改票不重发（24 小时同人同事去重在 tutorNotify）。
 * ★ 列表 / 均分对非作者只在 shared && !takenDown 时给（与详情同口径，不泄露存在性）。
 */
const mongoose = require("mongoose");
const Persona = require("../models/Persona");
const TutorRating = require("../models/TutorRating");
const TutorCourse = require("../models/TutorCourse");
const TutorRun = require("../models/TutorRun");
const { hasAnyBlockBetween } = require("../utils/blocking");
const { canRate, normalizeRating, summaryFromDist, emptyDist } = require("../tutor/core/publish/rating");
const notify = require("./tutorNotify.service");

const PAGE = 20;

async function loadPersona(personaId) {
  if (!mongoose.isValidObjectId(personaId)) return null;
  return Persona.findOne({ _id: personaId, kind: "tutor" }).select("_id author name shared takenDown").lean();
}

/** 这个人能不能评这位老师：把 canRate 要的几样从库里凑齐（判据仍只在 canRate 一处） */
async function eligibility(user, persona) {
  if (!user) return { ok: false, reason: "login", message: "登录后才能评分" };
  if (String(persona.author) === String(user._id)) return canRate({ isOwner: true });
  if (await hasAnyBlockBetween(user._id, persona.author)) return canRate({ blocked: true });
  const course = await TutorCourse.findOne({ owner: user._id, sourcePersona: persona._id }).select("_id").lean();
  if (!course) return canRate({ progress: null });
  const run = await TutorRun.findOne({ course: course._id, user: user._id }).select("progress status").lean();
  return canRate({ progress: (run && run.progress) || null, runStatus: run ? run.status : null });
}

async function summaryOf(personaId) {
  const rows = await TutorRating.aggregate([{ $match: { persona: new mongoose.Types.ObjectId(String(personaId)) } }, { $group: { _id: "$stars", n: { $sum: 1 } } }]);
  const dist = emptyDist();
  for (const r of rows) if (dist[r._id] !== undefined) dist[r._id] = r.n;
  return summaryFromDist(dist);
}

/** 从评分表重算均分 / 票数写回 Persona.stats（不 $inc） */
async function recompute(personaId) {
  const s = await summaryOf(personaId);
  await Persona.updateOne({ _id: personaId }, { $set: { "stats.ratingAvg": s.avg, "stats.ratingCount": s.count } });
  return s;
}

const view = (r) => (r ? {
  id: String(r._id), user: r.user && typeof r.user === "object" ? { _id: String(r.user._id), username: r.user.username || "" } : { _id: String(r.user || ""), username: "" },
  stars: r.stars, text: r.text || "", atVersion: r.atVersion || 0, createdAt: r.createdAt, updatedAt: r.updatedAt,
} : null);

async function list({ user, personaId, page = 1 }) {
  const persona = await loadPersona(personaId);
  if (!persona) return null;
  const isOwner = !!user && String(persona.author) === String(user._id);
  if (!(persona.shared && !persona.takenDown) && !isOwner) return null;
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const [summary, items, total, mine, can] = await Promise.all([
    summaryOf(persona._id),
    TutorRating.find({ persona: persona._id }).sort({ updatedAt: -1 }).skip((p - 1) * PAGE).limit(PAGE).populate("user", "_id username").lean(),
    TutorRating.countDocuments({ persona: persona._id }),
    user ? TutorRating.findOne({ persona: persona._id, user: user._id }).populate("user", "_id username").lean() : null,
    eligibility(user, persona),
  ]);
  return { summary, items: items.map(view), page: p, totalPages: Math.max(Math.ceil(total / PAGE), 1), total, mine: view(mine), canRate: can };
}

async function rate({ user, personaId, body }) {
  const persona = await loadPersona(personaId);
  if (!persona || !persona.shared || persona.takenDown) return { status: 404, body: { ok: false, message: "没有这位老师（不存在、未发布或已下架）" } };
  const can = await eligibility(user, persona);
  if (!can.ok) return { status: 403, body: { ok: false, code: "NOT_ELIGIBLE", reason: can.reason, message: can.message } };
  const n = normalizeRating(body);
  if (n.error) return { status: 400, body: { ok: false, message: n.error } };
  const course = await TutorCourse.findOne({ owner: user._id, sourcePersona: persona._id }).select("_id sourceVersion").lean();
  const existing = await TutorRating.findOne({ persona: persona._id, user: user._id });
  let id;
  if (existing) { existing.stars = n.stars; existing.text = n.text; existing.atVersion = (course && course.sourceVersion) || existing.atVersion || 0; await existing.save(); id = existing._id; }
  else { const created = await TutorRating.create({ persona: persona._id, user: user._id, course: course ? course._id : undefined, stars: n.stars, text: n.text, atVersion: (course && course.sourceVersion) || 0 }); id = created._id; }
  const summary = await recompute(persona._id);
  if (!existing) void notify.notifyTutor("TUTOR_RATING", { userId: persona.author, actorId: user._id, payload: { personaId: String(persona._id), personaName: persona.name || "", stars: n.stars, text: n.text.slice(0, 120) }, dedupe: { personaId: String(persona._id) } });
  const mine = await TutorRating.findById(id).populate("user", "_id username").lean();
  return { status: existing ? 200 : 201, body: { ok: true, created: !existing, mine: view(mine), summary } };
}

async function unrate({ user, personaId }) {
  const persona = await loadPersona(personaId);
  if (!persona) return { status: 404, body: { ok: false, message: "没有这位老师" } };
  const r = await TutorRating.deleteOne({ persona: persona._id, user: user._id });
  if (!r.deletedCount) return { status: 404, body: { ok: false, message: "你还没评过这位老师" } };
  const summary = await recompute(persona._id);
  return { status: 200, body: { ok: true, summary } };
}

module.exports = { eligibility, summaryOf, recompute, list, rate, unrate, view, PAGE };
