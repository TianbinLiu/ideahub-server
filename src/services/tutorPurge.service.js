"use strict";
/**
 * 删号级联里老师人格这一线（tutor 仓 docs/06 §4.1「级联」、docs/04 S14）。由 branchAdmin.controller.purgeUserCascade ⑩.7 **懒 require** 调用：
 *   开关关着也要删数据 —— TUTOR_ENABLED 管的是功能挂不挂，不是数据在不在；懒 require 是为了开关关着时 tutor 树零加载（D3）。
 *
 * ★★ 两份清单（BranchTemplate 曾经两份都不在、纯遗漏，app CLAUDE.md 坑表）。新加一张 Tutor* 表必须落在其中一份，tests/tutorPurge.spec.js 拿模型目录对着查：
 *   删（PURGE_DELETE）：
 *     TutorCourse（他的，含从市场开出来的）→ TutorMaterial（原件句柄先进 PendingAssetPurge，resourceType **raw**：教材是 raw 空间的 pdf / pptx / docx）
 *     → TutorChunk → TutorDoc → TutorRun（他的课上的 + 他作为 user 的）→ TutorTurn → TutorRevision → TutorExport → TutorJob → TutorUsage
 *     → Persona{kind:tutor, author}（他发布的老师）→ TutorRelease（那些老师的发布版）→ TutorRating（那些老师收的 + 他给别人的，后者重算别人的均分）
 *     → PersonaInstall / ArenaComment / Report（指向那些老师的；儿童安全举报按 Report.URGENT_REASONS 留下，与主级联 ⑧ 同一条例外）
 *   不删（PURGE_KEEP，刻意的）：
 *     · 别人从他的老师开出来的 TutorCourse / TutorRun / TutorDoc —— 那是别人的学习过程与自用件（教材本来就没复制）；只把 sourceOrphanedAt 标上，
 *       课程 summary 的 source 回 gone:true / orphaned:true，「合并新版」从此 409 SOURCE_GONE。
 *     · Notification：主级联 ⑩ 已按 userId / actorId 删（含四类 TUTOR_*）。
 *     · 陪聊人格（kind 不是 tutor）与它们的 PersonaInstall / ArenaComment：不归这里 —— 主级联头部写着 ideas / Persona 线是「已知未尽事项」。
 * ★ 句柄先落、再删库、最后由 assetPurge 清扫器 destroy（PendingAssetPurge 头上的理由）；句柄没落住不许因此拒绝删号。
 * ★ 串行不并行：与主级联同一条理由（连接数与可读的 removed 计数）。
 */
const mongoose = require("mongoose");
const TutorCourse = require("../models/TutorCourse");
const TutorMaterial = require("../models/TutorMaterial");
const TutorChunk = require("../models/TutorChunk");
const TutorDoc = require("../models/TutorDoc");
const TutorRun = require("../models/TutorRun");
const TutorTurn = require("../models/TutorTurn");
const TutorRevision = require("../models/TutorRevision");
const TutorExport = require("../models/TutorExport");
const TutorJob = require("../models/TutorJob");
const TutorUsage = require("../models/TutorUsage");
const TutorRelease = require("../models/TutorRelease");
const TutorRating = require("../models/TutorRating");
const Persona = require("../models/Persona");
const PersonaInstall = require("../models/PersonaInstall");
const ArenaComment = require("../models/ArenaComment");
const Report = require("../models/Report");
const PendingAssetPurge = require("../models/PendingAssetPurge");
const { recompute } = require("./tutorRating.service");

/** 删的那一份清单（模型名）——spec 拿 src/models/Tutor*.js 逐个对：每一张要么在这儿要么在 PURGE_KEEP 里 */
const PURGE_DELETE = ["TutorCourse", "TutorMaterial", "TutorChunk", "TutorDoc", "TutorRun", "TutorTurn", "TutorRevision", "TutorExport", "TutorJob", "TutorUsage", "TutorRelease", "TutorRating"];
/** 不删的那一份（刻意的）：键 = 模型名，值 = 理由 */
const PURGE_KEEP = {};

async function purgeTutorForUser(userId) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const removed = {};
  const courseIds = (await TutorCourse.find({ owner: uid }).select("_id").lean()).map((c) => c._id);

  // ① 教材原件的句柄先落（正文一删地址就没了）
  const mats = await TutorMaterial.find({ course: { $in: courseIds } }).select("_id publicId").lean();
  const handles = mats.filter((m) => m.publicId).map((m) => ({ publicId: String(m.publicId), resourceType: "raw", owner: uid, source: `tutor-material:${m._id}` }));
  if (handles.length) {
    try {
      await PendingAssetPurge.bulkWrite(handles.map((h) => ({ updateOne: { filter: { publicId: h.publicId }, update: { $setOnInsert: h }, upsert: true } })), { ordered: false });
    } catch (err) {
      if (!err || err.code !== 11000) console.warn("[tutor] 教材资产句柄落库失败:", err && (err.message || err));
    }
  }
  removed.tutorMaterialAssets = handles.length;

  // ② 课程树（他的课 + 他在别人课上的 run 这一形状今天不存在，但按 user 兜底）
  const runIds = (await TutorRun.find({ $or: [{ course: { $in: courseIds } }, { user: uid }] }).select("_id").lean()).map((r) => r._id);
  removed.tutorTurns = (await TutorTurn.deleteMany({ run: { $in: runIds } })).deletedCount;
  removed.tutorRevisions = (await TutorRevision.deleteMany({ run: { $in: runIds } })).deletedCount;
  removed.tutorRuns = (await TutorRun.deleteMany({ _id: { $in: runIds } })).deletedCount;
  removed.tutorChunks = (await TutorChunk.deleteMany({ course: { $in: courseIds } })).deletedCount;
  removed.tutorMaterials = (await TutorMaterial.deleteMany({ course: { $in: courseIds } })).deletedCount;
  removed.tutorDocs = (await TutorDoc.deleteMany({ $or: [{ course: { $in: courseIds } }, { owner: uid }] })).deletedCount;
  removed.tutorExports = (await TutorExport.deleteMany({ $or: [{ course: { $in: courseIds } }, { user: uid }] })).deletedCount;
  removed.tutorJobs = (await TutorJob.deleteMany({ $or: [{ course: { $in: courseIds } }, { owner: uid }] })).deletedCount;
  removed.tutorUsage = (await TutorUsage.deleteMany({ $or: [{ course: { $in: courseIds } }, { user: uid }] })).deletedCount;

  // ③ 他发布的老师人格：发布版、收到的评分、安装、评论、举报（儿童安全那些留下）
  const personaIds = (await Persona.find({ kind: "tutor", author: uid }).select("_id").lean()).map((p) => p._id);
  removed.tutorReleases = (await TutorRelease.deleteMany({ $or: [{ persona: { $in: personaIds } }, { owner: uid }] })).deletedCount;
  removed.tutorRatingsReceived = (await TutorRating.deleteMany({ persona: { $in: personaIds } })).deletedCount;
  // ④ 他给别人的评分：删行 + 重算那几位老师的均分（不 $inc，与评分服务同一把尺）
  const given = await TutorRating.find({ user: uid }).select("persona").lean();
  removed.tutorRatingsGiven = (await TutorRating.deleteMany({ user: uid })).deletedCount;
  const mine = new Set(personaIds.map(String));
  for (const pid of new Set(given.map((g) => String(g.persona)))) if (!mine.has(pid)) await recompute(pid);
  removed.tutorPersonaInstalls = personaIds.length ? (await PersonaInstall.deleteMany({ persona: { $in: personaIds } })).deletedCount : 0;
  removed.tutorPersonaComments = personaIds.length ? (await ArenaComment.deleteMany({ targetType: "persona", target: { $in: personaIds } })).deletedCount : 0;
  removed.tutorPersonaReports = personaIds.length ? (await Report.deleteMany({ reason: { $nin: Report.URGENT_REASONS }, targetType: "persona", targetId: { $in: personaIds } })).deletedCount : 0;
  // ⑤ 别人从他的老师开出来的课：保留，标 orphan（他们的学习过程不是他的数据）
  removed.tutorLearnersOrphaned = personaIds.length ? (await TutorCourse.updateMany({ sourcePersona: { $in: personaIds }, owner: { $ne: uid } }, { $set: { sourceOrphanedAt: new Date() } })).modifiedCount : 0;
  removed.tutorPersonas = personaIds.length ? (await Persona.deleteMany({ _id: { $in: personaIds } })).deletedCount : 0;
  // ⑥ 课本体最后删（中途挂了还能按 owner 重来）
  removed.tutorCourses = (await TutorCourse.deleteMany({ owner: uid })).deletedCount;
  return removed;
}

module.exports = { purgeTutorForUser, PURGE_DELETE, PURGE_KEEP };
