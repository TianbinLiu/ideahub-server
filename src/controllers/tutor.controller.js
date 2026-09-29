// src/controllers/tutor.controller.js
// 老师人格（tutor）的控制器：每个端点先 CourseCtx.load(courseId, req.user)（不是本人的课 404），再交给 services/tutor*.service.js。
// 端点契约 = tutor 仓 docs/06 §3.2 + docs/05 §5.6（本地参考实现 devServer.mjs 的路由表逐条对应），文档在 docs/api-contract.md「老师人格（tutor）」。
const mongoose = require("mongoose");
const User = require("../models/User");
const TutorJob = require("../models/TutorJob");
const TutorMaterial = require("../models/TutorMaterial");
const TutorCourse = require("../models/TutorCourse");
const { TUTOR_PRICES } = require("../config/tokens");
const { setWalletHeaders } = require("../services/arkGateway.service");
const { CourseCtx, validateCourseInput, normalizeCourseInput } = require("../services/tutorStore.service");
const ai = require("../services/tutorAi.service");
const market = require("../services/tutorMarket.service");
const pub = require("../services/tutorPublish.service");
const rating = require("../services/tutorRating.service");
const mergeSvc = require("../services/tutorMerge.service");
const file = require("../services/tutorFile.service");
const session = require("../services/tutorSession.service");
const distill = require("../services/tutorDistill.service");
const docs = require("../services/tutorDoc.service");
const { readLedger } = require("../services/tutorLedger.service");
const { aiConfig } = require("../tutor/core/ai/client");
const { currentStageId, reviewCard, reviewQuestions, dueReviews } = require("../tutor/core/session/index");
const { reviewRevision, revertOps, pendingOps } = require("../tutor/core/ops/index");
const { EXPORT_RETENTION_DAYS } = require("../tutor/core/export/index");

const fail = (res, status, message, extra = {}) => res.status(status).json({ ok: false, message, ...extra });
async function loadOr404(req, res, id) { const ctx = await CourseCtx.load(id, req.user); if (!ctx) { fail(res, 404, "没有这门课"); return null; } return ctx; }
async function needPersona(req, res, id) { const ctx = await loadOr404(req, res, id); if (!ctx) return null; if (!ctx.doc) { fail(res, 409, "这门课还没有生成老师人格：先在向导里生成", { code: "NO_PERSONA" }); return null; } return ctx; }
/** 教材按 sha 找主人：给了 courseId 就在那门课里找，否则在本人全部课里找（sha 全长或 ≥12 位前缀） */
async function materialCtx(req, res, sha, courseId) {
  if (courseId) { const ctx = await loadOr404(req, res, courseId); if (!ctx) return null; const m = await ctx.findMaterial(sha); if (!m) { fail(res, 404, "清单里没有这份教材"); return null; } return { ctx, material: m }; }
  const k = String(sha || "").toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(k)) { fail(res, 404, "清单里没有这份教材"); return null; }
  const courses = await TutorCourse.find({ owner: req.user._id }).select("_id").lean();
  const m = await TutorMaterial.findOne({ course: { $in: courses.map((c) => c._id) }, ...(k.length === 64 ? { sha: k } : { sha: { $regex: `^${k}` } }) });
  if (!m) { fail(res, 404, "清单里没有这份教材"); return null; }
  const ctx = await CourseCtx.load(m.course, req.user);
  return { ctx, material: m };
}
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (err) { next(err); } };

module.exports = {
  health: wrap(async (req, res) => res.json({ ok: true, tutor: true, demo: !aiConfig(), demoAllowed: ai.demoAllowed() })),
  config: wrap(async (req, res) => { const u = await User.findById(req.user._id).select("tutorAdultDeclaredAt").lean(); res.json({ ok: true, prices: TUTOR_PRICES, demo: !aiConfig(), adultDeclared: !!(u && u.tutorAdultDeclaredAt), adultDeclaredAt: (u && u.tutorAdultDeclaredAt) || null }); }),
  declareAdult: wrap(async (req, res) => { const at = new Date(); await User.updateOne({ _id: req.user._id, tutorAdultDeclaredAt: null }, { $set: { tutorAdultDeclaredAt: at } }); const u = await User.findById(req.user._id).select("tutorAdultDeclaredAt").lean(); res.json({ ok: true, adultDeclaredAt: u.tutorAdultDeclaredAt }); }),

  // ---- 课程
  listCourses: wrap(async (req, res) => { const list = await CourseCtx.listForUser(req.user); res.json({ ok: true, courses: await Promise.all(list.map((c) => c.summary())) }); }),
  createCourse: wrap(async (req, res) => { const bad = validateCourseInput(req.body); if (bad) return fail(res, 400, bad.message, { field: bad.field }); const ctx = await CourseCtx.create(req.user, normalizeCourseInput(req.body)); res.status(201).json({ ok: true, course: await ctx.summary() }); }),
  getCourse: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; res.json({ ok: true, course: await ctx.summary(), materials: await ctx.materials(), nameHint: null }); }),
  patchCourse: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; const merged = { ...ctx.meta, ...req.body, policy: { ...ctx.meta.policy, ...(req.body.policy || {}) } }; const bad = validateCourseInput(merged); if (bad) return fail(res, 400, bad.message, { field: bad.field }); await ctx.updateMeta(req.body); res.json({ ok: true, course: await ctx.summary() }); }),
  materialsProbe: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; const sha = String(req.query.sha256 || "").toLowerCase(); const list = await ctx.materials(); const hit = sha ? list.find((x) => x.sha === sha) : null; if (req.method === "HEAD") return res.status(hit ? 200 : 404).end(); res.json({ ok: true, exists: !!hit, material: hit || null, materials: sha ? undefined : list }); }),
  rules: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; res.json({ ok: true, rules: ai.hardRulesFrom(ctx.meta.policy, ctx.meta.key_dates || [], []) }); }),
  quote: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; res.json({ ok: true, ...(await ai.quoteOf(ctx)) }); }),

  // ---- 教材
  sign: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.body.courseId); if (!ctx) return; return ai.handleSign(ctx, req, res); }),
  confirm: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.body.courseId); if (!ctx) return; return ai.handleConfirm(ctx, req, res); }),
  materialLicense: wrap(async (req, res) => { const hit = await materialCtx(req, res, req.params.sha, req.body.courseId); if (!hit) return; try { const r = await hit.ctx.setMaterialLicense(hit.material, req.body.license.source); res.json({ ok: true, ...r, course: await hit.ctx.summary() }); } catch (e) { fail(res, 400, e.message); } }),
  materialFile: wrap(async (req, res) => { const hit = await materialCtx(req, res, req.params.sha); if (!hit) return; const url = ai.materialFileUrl(hit.material); if (!url) return fail(res, 404, "教材原件不在服务器上（上传没完成或还没配文件存储）—— 阅读面会退化成老师面板念", { code: "MATERIAL_MISSING" }); await file.pipeSignedDownload({ url, req, res, filename: hit.material.name, mime: hit.material.mime }); }), // ★ 不 302：理由在 tutorFile.service 头部
  materialText: wrap(async (req, res) => { const hit = await materialCtx(req, res, req.params.sha); if (!hit) return; const pages = await hit.ctx.pagesOf(hit.material); if (!pages) return fail(res, 404, "这份教材没有块级文本"); res.json({ sha: hit.material.sha, pages }); }),
  usageLedger: wrap(async (req, res) => res.json({ ok: true, ...(await readLedger({ user: req.user._id, since: req.query.since ? String(req.query.since) : undefined })) })),

  // ---- 人格：生成 / 作业 / 试教 / 扫描 / 导出导入
  generate: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.body.courseId); if (!ctx) return; const r = await ai.startGenerate(ctx, req.user, req.body.questionnaire); if (r.wallet) setWalletHeaders(res, r.wallet); res.status(r.status).json(r.body); }),
  getJob: wrap(async (req, res) => { if (!mongoose.isValidObjectId(req.params.id)) return fail(res, 404, "没有这个作业"); const job = await TutorJob.findOne({ _id: req.params.id, owner: req.user._id }); if (!job) return fail(res, 404, "没有这个作业"); res.json({ ok: true, job: ai.jobView(job) }); }),
  preview: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const b = req.body || {}; return session.handleTurn(ctx, req, res, { kind: b.kind === "ask" ? "ask" : "teach", stage: b.stage || (ctx.doc.map.stages[0] && ctx.doc.map.stages[0].stage_id), text: b.text, selection: b.selection }, { preview: true }); }),
  scan: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return ai.handleScan(ctx, req.user, res); }),
  accept: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return ai.handleAccept(ctx, req.user, res, req.params.pid, req.body || {}); }),
  exportPersona: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return docs.handleExport(ctx, req, res); }),
  listExports: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; res.json({ ok: true, exports: [...(await ctx.readExports())].reverse(), retainDays: EXPORT_RETENTION_DAYS }); }),
  importPersona: wrap(async (req, res) => docs.handleImport(req, res)),

  // ── 发布 / 市场（docs/02 §6 / §7，M2）
  publish: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const r = await pub.publish(ctx, req.user, req.body || {}); res.status(r.status).json(r.body); }),
  unpublish: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; const r = await pub.unpublish(ctx); res.status(r.status).json(r.body); }),
  market: wrap(async (req, res) => res.json({ ok: true, ...(await market.listMarket({ user: req.user || null, query: req.query })) })),
  marketDetail: wrap(async (req, res) => { const d = await market.getMarketDetail({ user: req.user || null, personaId: req.params.id }); if (!d) return fail(res, 404, "没有这位老师（不存在、未发布或已下架）"); res.json({ ok: true, ...d }); }),
  startRun: wrap(async (req, res) => { const r = await market.startLearning({ user: req.user, personaId: req.body.persona }); res.status(r.status).json(r.body); }),
  // ---- 评分（M2 后半）：规则在 core/publish/rating，存取在 tutorRating.service
  ratings: wrap(async (req, res) => { const r = await rating.list({ user: req.user || null, personaId: req.params.id, page: req.query.page }); if (!r) return fail(res, 404, "没有这位老师（不存在、未发布或已下架）"); res.json({ ok: true, ...r }); }),
  rate: wrap(async (req, res) => { const r = await rating.rate({ user: req.user, personaId: req.params.id, body: req.body || {} }); res.status(r.status).json(r.body); }),
  unrate: wrap(async (req, res) => { const r = await rating.unrate({ user: req.user, personaId: req.params.id }); res.status(r.status).json(r.body); }),
  // ---- 合并新版（docs/03 §6.3）
  mergeRelease: wrap(async (req, res) => { const ctx = await loadOr404(req, res, req.params.id); if (!ctx) return; const r = await mergeSvc.merge(ctx); res.status(r.status).json(r.body); }),

  // ---- Run（学习页）
  getRun: wrap(async (req, res) => {
    const ctx = await needPersona(req, res, req.params.id); if (!ctx) return;
    const turns = await ctx.readTurns();
    res.json({ ok: true, run: { id: ctx.id, status: ctx.run.status, progress: ctx.run.progress, currentStage: currentStageId(ctx.doc, ctx.run.progress), usage: ctx.run.usage, lastTurnSeq: ctx.run.turnSeq || 0, demo: !aiConfig(), startedAt: ctx.run.startedAt, doneAt: ctx.run.doneAt, distill: ctx.run.distill, dueReviews: dueReviews(ctx.doc, ctx.run.progress), pendingReview: (await ctx.pendingOps()).length }, doc: ctx.doc, materials: await ctx.materials(), turns: turns.slice(-60) });
  }),
  getTurns: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const after = Number(req.query.after || 0); res.json({ ok: true, turns: (await ctx.readTurns()).filter((t) => t.seq > after) }); }),
  getReviewCard: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; res.json({ ok: true, card: reviewCard(ctx.doc, ctx.run, await ctx.readTurns()) }); }),
  usageExport: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return docs.handleUsageExport(ctx, req, res); }),
  reviewDue: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const due = dueReviews(ctx.doc, ctx.run.progress); const upcoming = Object.entries(ctx.run.progress || {}).filter(([, p]) => p.status === "passed" && p.nextReviewAt).map(([stage_id, p]) => ({ stage_id, nextReviewAt: p.nextReviewAt })).sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt)); res.json({ ok: true, due, next: upcoming[0] || null }); }),
  reviewQuiz: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const stageId = String(req.query.stage || "") || (dueReviews(ctx.doc, ctx.run.progress)[0] && dueReviews(ctx.doc, ctx.run.progress)[0].stage_id); const stage = ctx.doc.map.stages.find((x) => x.stage_id === stageId); if (!stage) return fail(res, 404, "没有这个阶段"); if (!ctx.run.progress[stageId] || ctx.run.progress[stageId].status !== "passed") return fail(res, 409, `${stageId} 还没通过，谈不上回访`, { code: "NOT_PASSED" }); res.json({ ok: true, stage: stageId, title: stage.title, questions: reviewQuestions(ctx.doc, ctx.run, await ctx.readTurns(), stageId) }); }),
  revisions: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const all = await ctx.revisions(); res.json({ ok: true, revisions: [...all].reverse().map((r) => distill.revisionView(r, ctx.doc)), pending: pendingOps(all).length, version: ctx.doc.version, distill: ctx.run.distill }); }),
  progress: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const r = await ctx.applyAdvance({ type: "step", stage: req.body.stage, stepIdx: req.body.stepIdx }); if (r.error) return fail(res, 400, r.error); res.json({ ok: true, progress: ctx.run.progress, status: ctx.run.status, changed: r.changed }); }),
  turns: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return session.handleTurn(ctx, req, res, req.body || {}); }),
  quiz: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; return session.handleQuiz(ctx, req, res, req.body || {}); }),
  skip: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const r = await ctx.applyAdvance({ type: "skip", stage: req.body.stage, byAuthor: true }); if (r.error) return fail(res, 409, r.error); res.json({ ok: true, progress: ctx.run.progress, status: ctx.run.status, changed: r.changed, nextStage: currentStageId(ctx.doc, ctx.run.progress) }); }),
  feedback: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const ok = await ctx.setTurnFeedback(Number(req.body.seq), req.body.value === 1 ? 1 : req.body.value === -1 ? -1 : null); if (!ok) return fail(res, 404, "没有这一轮"); res.json({ ok: true }); }),
  distill: wrap(async (req, res) => { const ctx = await needPersona(req, res, req.params.id); if (!ctx) return; const r = await distill.runDistill(ctx, req.user, { reason: "manual" }); if (r.status === "busy") return fail(res, 409, r.why, { code: "BUSY" }); if (r.status === "denied") return res.status(r.billing ? 402 : 501).json({ ok: false, message: r.why, ...(r.billing || {}) }); if (r.billing && r.billing.wallet) setWalletHeaders(res, r.billing.wallet); res.json({ ok: true, status: r.status, why: r.why, window: r.window, errors: r.errors, revision: r.revision ? distill.revisionView(r.revision, ctx.doc) : null, learned: r.revision ? distill.learnedOf(r.revision) : null, pendingReview: (await ctx.pendingOps()).length, version: ctx.doc.version }); }),
  reviewRevision: wrap(async (req, res) => {
    const ctx = await needPersona(req, res, req.params.id); if (!ctx) return;
    try {
      const r = await reviewRevision(ctx.revisionStore(), ctx.doc, req.params.rid, { accept: req.body.accept || [], reject: req.body.reject || [] });
      const next = r.doc;
      if (r.applied.some((o) => o.status === "applied")) CourseCtx.bumpVersion(next, `作者点头 ${r.applied.length} 条修订`); // 点头了至少一条 = 铸新版（docs/02 4.5）
      await ctx.persistDoc(next);
      res.json({ ok: true, version: ctx.doc.version, applied: r.applied.map((o) => o.opId), rejected: r.rejected.map((o) => o.opId), revision: distill.revisionView(r.target, ctx.doc), pendingReview: (await ctx.pendingOps()).length });
    } catch (e) { fail(res, /没有 id 为/.test(e.message) ? 404 : 409, e.message); }
  }),
  revertRevision: wrap(async (req, res) => {
    const ctx = await needPersona(req, res, req.params.id); if (!ctx) return;
    try { const r = await revertOps(ctx.revisionStore(), ctx.doc, req.params.rid, req.body.opIds || []); await ctx.persistDoc(r.doc); res.json({ ok: true, revision: distill.revisionView(r.target, ctx.doc), revert: distill.revisionView(r.revision, ctx.doc), pendingReview: (await ctx.pendingOps()).length }); }
    catch (e) { fail(res, /没有 id 为/.test(e.message) ? 404 : 409, e.message); }
  }),
};
