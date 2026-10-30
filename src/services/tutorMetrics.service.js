"use strict";
/**
 * M3 与启梦互通的度量（tutor 仓 docs/06 §5.1「度量（每条都能防刷）」，2026-09-29）：
 *   ① 引流：recordReferral 记一行 —— 白名单 / 每天每主体每来源一条 / TTL 都在 TutorReferral + core/publish/referral，这里只是拼主体与落库；
 *   ② 跨产品激活：同一 user._id 既有 TutorRun 又是 BranchVideo 作者或有 CompanionSetting 的比例（distinct + $in，同库一趟）；
 *   ③ 反哺：CompanionSetting.persona 指向勾了 companion.enabled 的老师人格的账号数；「从市场开始学后 7 天内通过 ≥1 阶段」的比率（core forkActivated）。
 * ★ 只读、只给管理员（GET /api/tutor/admin/metrics）；数字按 user._id 去重，引流不奖励 —— 刷了也换不来东西，所以不做更重的防刷。
 */
const crypto = require("crypto");
const TutorReferral = require("../models/TutorReferral");
const TutorRun = require("../models/TutorRun");
const TutorCourse = require("../models/TutorCourse");
const Persona = require("../models/Persona");
const BranchVideo = require("../models/BranchVideo");
const CompanionSetting = require("../models/CompanionSetting");
const { normalizeFrom, normalizePath, referralDay, ratioOf, forkActivated, METRICS_WINDOW_DAYS, FORK_ACTIVATION_DAYS } = require("../tutor/core/publish/referral");

/** 游客的主体：IP 指纹（sha256 前 32 位）。不存明文 IP —— 度量只要"同一个人别重复算"，不需要知道他是谁 */
const ipSubject = (ip) => `ip:${crypto.createHash("sha256").update(String(ip || "")).digest("hex").slice(0, 32)}`;

/**
 * POST /api/tutor/referral { from, path? }：白名单归一 → 同一主体同一来源当天一条（唯一索引上 upsert，插进去才算记了）。
 * @returns {{ status:number, body:{ ok:true, recorded:boolean, from?:string, reason?:"unknown_from"|"duplicate" } }}
 */
async function recordReferral({ user, ip, from, path }) {
  const f = normalizeFrom(from);
  if (!f) return { status: 200, body: { ok: true, recorded: false, reason: "unknown_from" } };
  const subject = user ? `u:${String(user._id)}` : ipSubject(ip);
  const day = referralDay();
  try {
    const r = await TutorReferral.updateOne({ day, from: f, subject }, { $setOnInsert: { day, from: f, subject, user: user ? user._id : null, path: normalizePath(path), createdAt: new Date() } }, { upsert: true });
    const recorded = !!(r && (r.upsertedCount || r.upsertedId));
    return { status: recorded ? 201 : 200, body: { ok: true, recorded, from: f, ...(recorded ? {} : { reason: "duplicate" }) } };
  } catch (e) {
    if (e && e.code === 11000) return { status: 200, body: { ok: true, recorded: false, from: f, reason: "duplicate" } }; // 两发并发撞唯一索引：与"已记过"同一个答案
    throw e;
  }
}

/** GET /api/tutor/admin/metrics：三条度量，最近 METRICS_WINDOW_DAYS 天的引流 + 全量的激活 / 反哺 / fork 7 天 */
async function metrics({ days = METRICS_WINDOW_DAYS, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400 * 1000);
  const [referrals, tutorUsers] = await Promise.all([
    TutorReferral.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: "$from", count: { $sum: 1 }, subjects: { $addToSet: "$subject" } } },
      { $project: { _id: 0, from: "$_id", count: 1, users: { $size: "$subjects" } } },
      { $sort: { count: -1, from: 1 } },
    ]),
    TutorRun.distinct("user"),
  ]);
  const [videoAuthors, companionUsers, tutorPersonaIds, forkCourses] = await Promise.all([
    tutorUsers.length ? BranchVideo.distinct("author", { author: { $in: tutorUsers } }) : [],
    tutorUsers.length ? CompanionSetting.distinct("user", { user: { $in: tutorUsers } }) : [],
    Persona.distinct("_id", { kind: "tutor", "companion.enabled": true }),
    TutorCourse.find({ sourcePersona: { $ne: null } }).select("_id createdAt").lean(),
  ]);
  const crossUsers = new Set([...videoAuthors, ...companionUsers].map(String)).size;
  const accounts = tutorPersonaIds.length ? await CompanionSetting.countDocuments({ persona: { $in: tutorPersonaIds } }) : 0;
  const forkedAt = new Map(forkCourses.map((c) => [String(c._id), c.createdAt]));
  const runs = forkCourses.length ? await TutorRun.find({ course: { $in: forkCourses.map((c) => c._id) } }).select("course progress").lean() : [];
  const activatedCourses = new Set(runs.filter((r) => forkActivated(r.progress, forkedAt.get(String(r.course)))).map((r) => String(r.course)));
  return {
    ok: true, days, since: since.toISOString(), referrals,
    activation: { tutorUsers: tutorUsers.length, crossUsers, ratio: ratioOf(crossUsers, tutorUsers.length) },
    companion: { personas: tutorPersonaIds.length, accounts },
    fork7d: { days: FORK_ACTIVATION_DAYS, forks: forkCourses.length, activated: activatedCourses.size, ratio: ratioOf(activatedCourses.size, forkCourses.length) },
  };
}

module.exports = { recordReferral, metrics, ipSubject };
