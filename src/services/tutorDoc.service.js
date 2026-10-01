// src/services/tutorDoc.service.js
// 导出 / 导入 / 使用记录（tutor 仓 docs/02 §5、docs/03 §8 §9、docs/05 §5.4；核心实现在 core/export/index.js，与 tutor 仓 CLI 同一份）。
// 这里只做 IO：读教材文本给泄漏核查、回文件、留痕进 TutorExport、导入落 TutorDoc / 新开一门课。
//   · 发布件（audience=market）对 license.source=unsure 整句拒（core/format/validate）；教材泄漏核查不过 409 并指出段落；
//   · 每次导出留一条痕（《标识办法》第九条 ≥ 6 个月）：谁 / 何时 / 哪版 / 格式 / sha256 / 标识元数据；
//   · 导入优先 json 镜像、只有 .md 时按固定标题解析；删标识 / 改正文整句拒；回读自己的发布件不丢工作区的 ② 与学生问答、进度保留。
const { buildExport, zipExport, exportRecord, exportFileName, parseImport, mergeImport, usageRecords, renderUsage, EXPORT_FORMATS, EXPORT_MIME, EXPORT_RETENTION_DAYS } = require("../tutor/core/export/index");
const { renderTutorDoc, sha256Hex } = require("../tutor/core/format/index");
const { progressToDoc } = require("../tutor/core/session/index");
const { appendRevision } = require("../tutor/core/ops/index");
const { aiConfig } = require("../tutor/core/ai/client");
const { CourseCtx } = require("./tutorStore.service");

const attachment = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const flag = (q, k) => ["1", "true"].includes(String(q[k] || ""));

/** GET /personas/:id/export?format=md|json|zip&audience=market|self&keepStuckPoints&keepStudentQa&skipCleanCheck */
async function handleExport(ctx, req, res) {
  const q = req.query || {};
  const format = String(q.format || "md");
  if (!EXPORT_FORMATS.includes(format)) return res.status(400).json({ ok: false, message: `format 只能是 ${EXPORT_FORMATS.join(" / ")}` });
  const audience = String(q.audience || "market");
  const materials = await ctx.materialTextsForCheck();
  const r = buildExport(ctx.doc, { audience, materials: materials.length ? materials : null, keepStuckPoints: flag(q, "keepStuckPoints"), keepStudentQa: flag(q, "keepStudentQa"), skipCleanCheck: flag(q, "skipCleanCheck") });
  if (!r.ok) return res.status(r.code === "CLEAN_CHECK" ? 409 : 400).json({ ok: false, message: r.message, code: r.code, errors: r.errors, worst: (r.clean && r.clean.worst) || null });
  const body = format === "md" ? Buffer.from(r.text) : format === "json" ? Buffer.from(r.jsonText) : await zipExport(r);
  const name = exportFileName(r.doc, format);
  const rec = await ctx.logExport(exportRecord({ doc: r.doc, checksum: r.checksum, format, bytes: body.length, sha256: sha256Hex(body), by: "author", extra: { cleanCheck: r.cleanSkipped ? "skipped" : "passed", name } }));
  res.set({ "Content-Type": EXPORT_MIME[format], "Content-Length": String(body.length), "Content-Disposition": attachment(name), "Cache-Control": "no-store", "X-Tutor-Checksum": r.checksum, "X-Tutor-Produce-Id": r.doc.AIGC.ProduceID, "X-Tutor-Clean-Check": r.cleanSkipped ? "skipped" : "passed", "X-Tutor-Export-Id": rec.id, "Access-Control-Expose-Headers": "Content-Disposition, X-Tutor-Checksum, X-Tutor-Produce-Id, X-Tutor-Clean-Check, X-Tutor-Export-Id, X-Wallet-Plan, X-Wallet-Addon, X-Wallet-Debt" });
  res.status(200).end(body);
}

/** POST /personas/import { courseId?, text?|json?, filename? }：同一位老师回读成 kind:import 修订，别人的老师新开一门课 */
async function handleImport(req, res) {
  const body = req.body || {};
  const parsed = parseImport({ text: body.text, json: body.json });
  if (!parsed.ok) return res.status(400).json({ ok: false, message: parsed.message, code: "IMPORT", errors: parsed.errors });
  const incoming = parsed.doc;
  let ctx = body.courseId ? await CourseCtx.load(String(body.courseId), req.user) : null;
  if (body.courseId && !ctx) return res.status(404).json({ ok: false, message: "没有这门课" });
  const same = !!(ctx && ctx.doc && ctx.doc.id === incoming.id);
  let created = false;
  if (!ctx || (ctx.doc && !same)) { ctx = await CourseCtx.createFromDoc(req.user, incoming); created = true; } // 没指定课、或指定的课里是另一位老师 → 新开一门课
  try {
    await ctx.writePersona(renderTutorDoc(mergeImport(same ? ctx.doc : null, incoming)).text);
    await ctx.persistDoc(progressToDoc(ctx.doc, ctx.run.progress));
  } catch (e) { return res.status(400).json({ ok: false, message: `导入的文件存不下：${e.message}` }); }
  const rec = await appendRevision(ctx.revisionStore(), { kind: "import", ops: [], summary: `${same ? "回读自己导出的" : "导入"}人格 v${incoming.version}（${parsed.source}，${incoming.audience === "market" ? "发布件" : "自用件"}）`, by: "user", review: "n/a", source: { checksum: parsed.checksum, format: parsed.source, from: body.filename || null, audience: incoming.audience, warnings: parsed.warnings } });
  return res.status(200).json({ ok: true, courseId: ctx.id, created, same, personaId: ctx.doc.id, name: ctx.doc.name, version: ctx.doc.version, checksum: parsed.checksum, source: parsed.source, warnings: parsed.warnings, revisionId: rec.id, stages: ctx.doc.map.stages.length });
}

/** GET /runs/:id/usage-export?format=md|csv|json&from&to（复旦承诺书四项） */
async function handleUsageExport(ctx, req, res) {
  const q = req.query || {};
  const format = String(q.format || "md");
  if (!["md", "csv", "json"].includes(format)) return res.status(400).json({ ok: false, message: "format 只能是 md / csv / json" });
  const cfg = aiConfig();
  const rec = usageRecords({ doc: ctx.doc, course: ctx.meta, run: { ...ctx.run.toObject(), demo: !cfg }, turns: await ctx.readTurns(), model: cfg && cfg.model, from: q.from ? String(q.from) : undefined, to: q.to ? String(q.to) : undefined });
  const text = renderUsage(rec, format);
  const name = `usage-${ctx.id}-${new Date().toISOString().slice(0, 10)}.${format}`;
  res.set({ "Content-Type": { md: EXPORT_MIME.md, csv: "text/csv; charset=utf-8", json: EXPORT_MIME.json }[format], "Content-Disposition": attachment(name), "Cache-Control": "no-store", "X-Tutor-Usage-Rows": String(rec.rows.length), "Access-Control-Expose-Headers": "Content-Disposition, X-Tutor-Usage-Rows" });
  res.status(200).send(text);
}

module.exports = { handleExport, handleImport, handleUsageExport, EXPORT_RETENTION_DAYS };
