"use strict";
/**
 * 老师人格市场（docs/02 §7、docs/06 §4.1）：GET /api/tutor/market 走自己的端点、不借 /api/personas?kind=（监管若停陪聊线不连坐，docs/05 A6）。
 * 数据仍是 Persona{kind:"tutor"} + currentDoc（TutorRelease）。只回 shared && !takenDown；scope=mine 含作者自己没公开的；未登录 scope 一律退 all。
 * 排序：new 时间；hot 下载 → 点赞 → 时间（与老市场同款）；rating 均分、票数 < 3 沉底（aggregate 里算一列 ratingRank）。
 * 拉黑：登录用户看不到拉黑 / 被拉黑的作者（utils/blocking，与作品流同一份）；详情与「开始学」同样拒。
 * 「开始跟这位老师学」（docs/02 5.7）= 从发布版复制出学习者自己的一门课（教材不复制、进度全 pending），PersonaInstall +1（幂等）。
 */
const mongoose = require("mongoose");
const Persona = require("../models/Persona");
const PersonaInstall = require("../models/PersonaInstall");
const PersonaPurchase = require("../models/PersonaPurchase");
const TutorRelease = require("../models/TutorRelease");
const TutorCourse = require("../models/TutorCourse");
const User = require("../models/User");
const { listBlockedUserIds, hasAnyBlockBetween } = require("../utils/blocking");
const { CourseCtx } = require("./tutorStore.service");

const TUTOR_KIND = "tutor";
const LIMIT_MAX = 40;
const RATING_MIN_VOTES = 3; // 票数低于这个数的老师在 sort=rating 里沉底（先量再定）
const SORTS = ["new", "hot", "rating"];
const SCOPES = ["all", "installed", "mine"];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 纯函数：查询参数 → 归一化（未登录 scope 退 all，limit ≤ 40） */
function parseQuery(q = {}, user = null) {
  const page = Math.max(parseInt(q.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit || "12", 10) || 12, 1), LIMIT_MAX);
  const sort = SORTS.includes(String(q.sort || "")) ? String(q.sort) : "new";
  let scope = SCOPES.includes(String(q.scope || "")) ? String(q.scope) : "all";
  if (scope !== "all" && !user) scope = "all";
  return { page, limit, sort, scope, q: String(q.q || "").trim().slice(0, 100), tag: String(q.tag || "").trim().toLowerCase().slice(0, 40), subject: String(q.subject || "").trim().slice(0, 60), author: String(q.author || "").trim() };
}

/** 纯函数：Mongo 过滤条件（spec 对形状）。blockedIds 是字符串 id 的集合 / 数组。 */
function marketFilter(p, { userId = null, installedIds = null, blockedIds = [] } = {}) {
  const f = { kind: TUTOR_KIND };
  const blocked = [...blockedIds].map(String);
  if (p.scope === "mine") { f.author = userId; }
  else {
    f.shared = true; f.takenDown = { $ne: true };
    const author = {};
    if (p.author && mongoose.isValidObjectId(p.author)) author.$eq = p.author;
    if (blocked.length) author.$nin = blocked;
    if (Object.keys(author).length) f.author = author;
  }
  if (p.scope === "installed") f._id = { $in: installedIds || [] };
  if (p.tag) f.tags = p.tag;
  if (p.subject) f.subject = new RegExp(`^${escapeRegex(p.subject)}$`, "i");
  if (p.q) { const re = new RegExp(escapeRegex(p.q), "i"); f.$or = [{ name: re }, { description: re }, { tags: re }, { subject: re }]; }
  return f;
}

function authorOf(p) { return p.author && typeof p.author === "object" ? { _id: String(p.author._id), username: p.author.username || "" } : { _id: String(p.author || ""), username: "" }; }

/** 市场卡片（列表与详情共用一份形状） */
function toMarketCard(p, { installedSet = new Set(), userId = null } = {}) {
  return {
    id: String(p._id), name: p.name, description: p.description || "", coverEmoji: p.coverEmoji || "🎓", coverImageUrl: p.coverImageUrl || "",
    tags: Array.isArray(p.tags) ? p.tags : [], subject: p.subject || "", author: authorOf(p), price: Number(p.price || 0),
    version: Number(p.releaseVersion || 0), shared: !!p.shared, takenDown: !!p.takenDown,
    stats: { downloadCount: Number((p.stats && p.stats.downloadCount) || 0), likeCount: Number((p.stats && p.stats.likeCount) || 0), ratingAvg: Number((p.stats && p.stats.ratingAvg) || 0), ratingCount: Number((p.stats && p.stats.ratingCount) || 0) },
    installed: installedSet.has(String(p._id)), isOwner: !!userId && String(userId) === authorOf(p)._id,
    publishedAt: p.aigcDeclaredAt || p.updatedAt || p.createdAt, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

/** 详情页的只读预览：① 人格卡的教学面 + ③ 课程地图（每阶段几步 / 几条必背 / 几道自检）+ ⑥ 复刻指南 —— 不带 ② ④ 正文（那是下载后才有的） */
function previewOf(doc) {
  const card = (doc && doc.card) || {};
  const rules = Array.isArray(card.hard_rules) ? card.hard_rules : [];
  const st = (id) => (doc.distill && doc.distill[id]) || {};
  return {
    card: { who: card.who || "", teaching_style: card.teaching_style || "", catchphrases: Array.isArray(card.catchphrases) ? card.catchphrases : [], hard_rules: rules.map((r) => (typeof r === "string" ? { text: r, locked: false } : { text: r.text || "", locked: !!r.locked })) },
    stages: ((doc.map && doc.map.stages) || []).map((s) => ({ stage_id: s.stage_id, title: s.title, summary: s.summary || "", steps: (st(s.stage_id).walkthrough || []).length, memo: (st(s.stage_id).must_memorize || []).length, checks: (st(s.stage_id).self_checks || []).length })),
    guide: typeof doc.guide === "string" ? doc.guide : "",
    subject: doc.subject || "", course: doc.course || null, language: doc.language || "", policy: doc.policy || null, license: doc.license || null,
  };
}

const sortSpec = (sort) => (sort === "hot" ? { "stats.downloadCount": -1, "stats.likeCount": -1, createdAt: -1 } : { createdAt: -1 });

async function fetchPage(f, sort, page, limit) {
  if (sort !== "rating") return Persona.find(f).sort(sortSpec(sort)).skip((page - 1) * limit).limit(limit).populate("author", "_id username").lean();
  const rows = await Persona.aggregate([
    { $match: f },
    { $addFields: { ratingRank: { $cond: [{ $gte: [{ $ifNull: ["$stats.ratingCount", 0] }, RATING_MIN_VOTES] }, { $ifNull: ["$stats.ratingAvg", 0] }, -1] } } },
    { $sort: { ratingRank: -1, "stats.ratingCount": -1, createdAt: -1 } },
    { $skip: (page - 1) * limit }, { $limit: limit },
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.author) } }).select("_id username").lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => ({ ...r, author: byId.get(String(r.author)) || r.author }));
}

async function installedSetFor(user, rows) {
  if (!user || !rows.length) return new Set();
  const hits = await PersonaInstall.find({ user: user._id, persona: { $in: rows.map((r) => r._id) } }).select("persona").lean();
  return new Set(hits.map((h) => String(h.persona)));
}

async function listMarket({ user = null, query = {} }) {
  const p = parseQuery(query, user);
  const blockedIds = user ? await listBlockedUserIds(user._id) : [];
  const installedIds = p.scope === "installed" ? (await PersonaInstall.find({ user: user._id }).select("persona").lean()).map((x) => x.persona) : null;
  const f = marketFilter(p, { userId: user && user._id, installedIds, blockedIds });
  const [total, rows] = await Promise.all([Persona.countDocuments(f), fetchPage(f, p.sort, p.page, p.limit)]);
  const installedSet = await installedSetFor(user, rows);
  return { items: rows.map((r) => toMarketCard(r, { installedSet, userId: user && user._id })), page: p.page, limit: p.limit, total, totalPages: Math.max(Math.ceil(total / p.limit), 1), sort: p.sort, scope: p.scope, q: p.q, tag: p.tag, subject: p.subject };
}

/** 详情：未发布 / 已下架的只有作者看得到（非作者 404，不泄露存在性，docs/02 6.6）；拉黑互不可见 */
async function getMarketDetail({ user = null, personaId }) {
  if (!mongoose.isValidObjectId(personaId)) return null;
  const p = await Persona.findOne({ _id: personaId, kind: TUTOR_KIND }).populate("author", "_id username").lean();
  if (!p) return null;
  const authorId = authorOf(p)._id;
  const isOwner = !!user && String(user._id) === authorId;
  if (!(p.shared && !p.takenDown) && !isOwner) return null;
  if (user && !isOwner && (await hasAnyBlockBetween(user._id, authorId))) return null;
  const [rel, others, installed, myCourse] = await Promise.all([
    p.currentDoc ? TutorRelease.findById(p.currentDoc).lean() : null,
    Persona.find({ kind: TUTOR_KIND, author: authorId, shared: true, takenDown: { $ne: true }, _id: { $ne: p._id } }).sort({ createdAt: -1 }).limit(6).populate("author", "_id username").lean(),
    user ? PersonaInstall.exists({ user: user._id, persona: p._id }) : null,
    user ? TutorCourse.findOne({ owner: user._id, sourcePersona: p._id }).select("_id sourceVersion").lean() : null,
  ]);
  return {
    persona: toMarketCard(p, { installedSet: new Set(installed ? [String(p._id)] : []), userId: user && user._id }),
    release: rel ? { version: rel.version, sha256: rel.sha256, checksum: rel.checksum, produceId: rel.produceId, publishedAt: rel.publishedAt, note: rel.note || "", stages: rel.stages } : null,
    preview: rel ? previewOf(rel.doc) : null,
    others: others.map((o) => toMarketCard(o, { userId: user && user._id })),
    relation: { isOwner, installed: !!installed, learning: myCourse ? { courseId: String(myCourse._id), version: myCourse.sourceVersion || 0 } : null, ownCourse: isOwner && p.course ? String(p.course) : null },
    ...(isOwner && p.takenDown ? { takedown: { at: p.takenDownAt || null, reason: p.takenDownReason || "" } } : {}),
  };
}

/**
 * 「开始跟这位老师学」：从发布版复制出学习者自己的一门课（与「导入一位老师」同一条路：createFromDoc + writePersona），教材不复制、进度全 pending。
 * 幂等：同一人对同一位老师只开一门；作者自己点 = 回自己那门课。付费老师（price>0）要 PersonaPurchase 结算过（v1 全免费，这条只是闸的形状，docs/02 5.11）。
 */
async function startLearning({ user, personaId }) {
  if (!mongoose.isValidObjectId(personaId)) return { status: 404, body: { ok: false, message: "没有这位老师" } };
  const p = await Persona.findOne({ _id: personaId, kind: TUTOR_KIND }).lean();
  if (!p) return { status: 404, body: { ok: false, message: "没有这位老师" } };
  const isOwner = String(p.author) === String(user._id);
  if (!(p.shared && !p.takenDown) && !isOwner) return { status: 404, body: { ok: false, message: "没有这位老师（未发布或已下架）" } };
  if (isOwner) return { status: 200, body: { ok: true, courseId: String(p.course), created: false, own: true } };
  if (await hasAnyBlockBetween(user._id, p.author)) return { status: 403, body: { ok: false, code: "BLOCKED", message: "Blocked users cannot interact." } };
  if (Number(p.price || 0) > 0) {
    const paid = await PersonaPurchase.exists({ user: user._id, persona: p._id, settledAt: { $ne: null } });
    if (!paid) return { status: 403, body: { ok: false, code: "unpaid", message: "这位老师是付费的，先购买再开始学" } };
  }
  const rel = p.currentDoc ? await TutorRelease.findById(p.currentDoc).lean() : null;
  if (!rel) return { status: 409, body: { ok: false, code: "NO_RELEASE", message: "这位老师还没有发布版" } };
  const existing = await TutorCourse.findOne({ owner: user._id, sourcePersona: p._id }).select("_id sourceVersion").lean();
  if (existing) return { status: 200, body: { ok: true, courseId: String(existing._id), created: false, version: existing.sourceVersion || 0, latest: rel.version } };
  const ctx = await CourseCtx.createFromDoc(user, rel.doc);
  ctx.course.sourcePersona = p._id; ctx.course.sourceRelease = rel._id; ctx.course.sourceVersion = rel.version;
  await ctx.course.save();
  await ctx.writePersona(rel.text);
  await PersonaInstall.updateOne({ user: user._id, persona: p._id }, { $setOnInsert: { user: user._id, persona: p._id } }, { upsert: true });
  const downloadCount = await PersonaInstall.countDocuments({ persona: p._id });
  await Persona.updateOne({ _id: p._id }, { $set: { "stats.downloadCount": downloadCount } });
  return { status: 201, body: { ok: true, courseId: ctx.id, created: true, version: rel.version, latest: rel.version, downloadCount } };
}

module.exports = { parseQuery, marketFilter, toMarketCard, previewOf, listMarket, getMarketDetail, startLearning, LIMIT_MAX, RATING_MIN_VOTES, SORTS, SCOPES };
