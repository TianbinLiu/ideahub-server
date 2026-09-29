"use strict";
/**
 * 合并新版（tutor 仓 docs/03 §6.3、docs/02 5.9 / 6.5；POST /api/tutor/courses/:id/merge-release）：学习者把自己那门课（从 v(n) 复制来的）合到作者的 v(n+1)。
 * ★ 规则在核心包 core/publish/merge.mergeRelease（三方：mine = 学习者手里的 / base = 当初复制的那版发布件 / release = 最新版），参考实现同一份；
 *   这里只负责取三份、落两处（doc + run.progress）、挪指针（TutorCourse.sourceRelease / sourceVersion / mergedAt）。
 * ★ 只有 shared && !takenDown 的老师才能合（与市场可见同口径）；已是最新 409 UP_TO_DATE；不是从市场开的课 409 NOT_FORKED。
 * ★ 消失的阶段进度进 run.archived（不删，docs/03 §6.3「归档不删」）；版本备注 / 回执用同一句 describeMerge。
 */
const Persona = require("../models/Persona");
const TutorRelease = require("../models/TutorRelease");
const TutorCourse = require("../models/TutorCourse");
const { CourseCtx } = require("./tutorStore.service");
const { mergeRelease, describeMerge } = require("../tutor/core/publish/merge");
const { nextReviewAt, runStatusOf } = require("../tutor/core/session/index");

/** 课程 summary 里 source 那一格：钉的版本 + 最新版 + 有没有可合的（老师不在市场上时 latest 为 null、gone:true） */
async function sourceState(course) {
  if (!course || !course.sourcePersona) return null;
  const p = await Persona.findById(course.sourcePersona).select("name shared takenDown releaseVersion").lean();
  const visible = !!(p && p.shared && !p.takenDown);
  const latest = visible ? Number(p.releaseVersion || 0) : null;
  const version = course.sourceVersion || 0;
  return { personaId: String(course.sourcePersona), personaName: (p && p.name) || "", version, latest, updateAvailable: !!(latest && latest > version), mergedAt: course.mergedAt || null, gone: !visible };
}

async function merge(ctx) {
  const course = ctx.course;
  if (!course.sourcePersona) return { status: 409, body: { ok: false, code: "NOT_FORKED", message: "这门课不是从市场「开始跟这位老师学」开出来的，没有可合并的新版" } };
  if (!ctx.doc) return { status: 409, body: { ok: false, code: "NO_PERSONA", message: "这门课还没有老师" } };
  const p = await Persona.findById(course.sourcePersona).select("name shared takenDown currentDoc releaseVersion").lean();
  if (!p || !p.shared || p.takenDown) return { status: 409, body: { ok: false, code: "SOURCE_GONE", message: "这位老师已不在市场上（下架或取消分享），合不了新版" } };
  const rel = p.currentDoc ? await TutorRelease.findById(p.currentDoc).lean() : null;
  if (!rel) return { status: 409, body: { ok: false, code: "SOURCE_GONE", message: "这位老师还没有可用的发布版" } };
  if (rel.version <= (course.sourceVersion || 0)) return { status: 409, body: { ok: false, code: "UP_TO_DATE", message: `已经是最新版（v${rel.version}），没有可合并的` } };
  const base = course.sourceRelease ? await TutorRelease.findById(course.sourceRelease).select("doc").lean() : null;
  const r = mergeRelease({ mine: ctx.doc, release: rel.doc, base: base ? base.doc : null, progress: ctx.run.progress || {}, releaseVersion: rel.version }); // 回执说发布版号（市场上的 v2），不是文档自己的 version
  const note = describeMerge(r.report, p.name);
  ctx.run.progress = r.progress;
  ctx.run.status = runStatusOf(r.doc, r.progress); // 新增了段 → 走完的课重新 active
  ctx.run.archived = { ...(ctx.run.archived || {}), ...r.archived };
  ctx.run.markModified("archived");
  const nra = nextReviewAt(r.progress);
  ctx.run.nextReviewAt = nra ? new Date(nra) : null;
  await ctx.persistRun();
  await ctx.persistDoc(CourseCtx.bumpVersion(r.doc, note));
  const mergedAt = new Date();
  await TutorCourse.updateOne({ _id: course._id }, { $set: { sourceRelease: rel._id, sourceVersion: rel.version, mergedAt } });
  course.sourceRelease = rel._id; course.sourceVersion = rel.version; course.mergedAt = mergedAt;
  return { status: 200, body: { ok: true, version: ctx.doc.version, note, report: r.report, source: await sourceState(course) } };
}

module.exports = { merge, sourceState };
