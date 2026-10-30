// src/services/tutorAi.service.js
// 生成人格与教材（tutor 仓 docs/05 §4、docs/04 §5 S24；参考实现 devServer.mjs 的 startGenerate / handleScan / handleAccept / handleSign / handleConfirm 逐段搬来）。
//   · 生成是长活：端点只受理 + 回 jobId（TutorJob），tutor.worker 在 0 号实例串行跑 core/generate/pipeline.runGenerate，检查点落 job.checkpoint 断了接着跑；
//     钱在受理那一拍按报价（generateQuote = tutor_extract × (教材数 + 阶段数 + 1)）走 billing.chargedCall 扣一次，之后失败不退（docs/05 §4.8 与 W2 同口径）；
//   · 教材直传：POST /materials/sign 出 Cloudinary raw 直传票（public_id 服务端签死、allowed_formats 白名单、overwrite:false），
//     POST /materials/confirm 收浏览器抽好的 pages + sha256：Admin API 核对 public_id 真的在、格式与体积对；按 sha 去重；
//   · 扫描目录（docs/05 §4.6）：清单里还没进 ③ 的教材 → 阶段提议（pending）→ 作者点头才追加成新版。
// ★ 演示模式（没配 AI key）：生成走 core/generate/demo 的确定性产物。生产不许静默走演示：demoAllowed() 只在非生产、或显式 TUTOR_ALLOW_DEMO=1 时为真。
const crypto = require("node:crypto");
// ★ config/cloudinary 导出的是 { cloudinary, validateCloudinaryConfig }，必须解构（全仓其它十几处都这么写）。
//   2026-09-30 之前这里整体 require：.api / .uploader 都是 undefined，配了 Cloudinary 的生产上每份教材验收都被下面的 catch 接成 502，
//   同 sha 重复传则 destroy 同步抛成 500。tests/tutor.spec.js 那条整链要 Mongo，此前没在任何机器上跑过，所以一直没暴露。
const { cloudinary } = require("../config/cloudinary");
const { cloudinaryReady, signDirectUpload, directDownloadUrl } = require("./directUpload.service");
const billing = require("./billing.service");
const { priceOf } = require("../config/tokens");
const TutorJob = require("../models/TutorJob");
const { aiConfig } = require("../tutor/core/ai/client");
const { runGenerate, planGenerate, proposeStages, presetOf, realNameHint, hardRulesFrom } = require("../tutor/core/generate/index");
const { validateOpsBatch, applyOps, appendRevision } = require("../tutor/core/ops/index");
const { CourseCtx, SUPPORTED_FORMATS } = require("./tutorStore.service");

const MATERIAL_FOLDER = "ideahub/tutor-materials";
/** 单文件上限（TUTOR_MATERIAL_MAX_BYTES，缺省 100MB —— 与成片直传同一档，先量再定） */
const maxBytes = () => Number(process.env.TUTOR_MATERIAL_MAX_BYTES || 100 * 1024 * 1024);

function demoAllowed() { return process.env.NODE_ENV !== "production" || process.env.TUTOR_ALLOW_DEMO === "1"; }
const modeNow = () => (aiConfig() ? "model" : "demo");

// ---- 报价
async function quoteOf(ctx) {
  const mats = await ctx.materialsWithPages();
  const plan = mats.length ? planGenerate(mats) : { sections: [], quote: null };
  return { materials: mats.length, sections: plan.sections.length, stages: plan.sections.length, quote: plan.quote, demo: !aiConfig() };
}

// ---- 直传票 + 验收
function publicIdOf(userId, ext) { return `${MATERIAL_FOLDER}/${String(userId)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`; }
/** 归属判据：只认本账号、本目录、带后缀的形状（与 ownWorkshopMediaPublicId 同一条纪律：公网地址不算数） */
function ownMaterialPublicId(raw, userId) {
  const m = new RegExp(`^${MATERIAL_FOLDER}/${String(userId)}-\\d+-[0-9a-f]{6}\\.(${SUPPORTED_FORMATS.join("|")})$`).exec(String(raw || ""));
  return m ? { publicId: m[0], ext: m[1] } : null;
}
function handleSign(ctx, req, res) {
  if (!cloudinaryReady()) return res.status(503).json({ ok: false, message: "服务器还没配好文件存储，暂时不能上传教材。" });
  const body = req.body || {};
  const ext = String(body.format || "").toLowerCase().replace(/^\./, "");
  if (!SUPPORTED_FORMATS.includes(ext)) return res.status(400).json({ ok: false, message: `只收 ${SUPPORTED_FORMATS.join(" / ")}，给的是「${ext || "?"}」`, code: "FORMAT" });
  const bytes = Number(body.bytes || 0);
  if (!(bytes > 0)) return res.status(400).json({ ok: false, message: "bytes 要是正数" });
  if (bytes > maxBytes()) return res.status(413).json({ ok: false, message: `单文件上限 ${Math.round(maxBytes() / 1024 / 1024)}MB（TUTOR_MATERIAL_MAX_BYTES，先量再定）`, code: "TOO_LARGE" });
  const publicId = publicIdOf(req.user._id, ext);
  const signed = signDirectUpload({ resourceType: "raw", publicId, allowedFormats: SUPPORTED_FORMATS, maxSizeBytes: maxBytes() });
  // 与 tutor 仓参考实现同一形状（ticket = publicId；putUrl 是 Cloudinary 的上传地址，客户端按 params 逐字段转发）
  return res.json({ ok: true, ticket: publicId, putUrl: signed.uploadUrl, publicId, params: signed.params, maxBytes: maxBytes(), chunkBytes: signed.chunkBytes });
}
async function handleConfirm(ctx, req, res) {
  const body = req.body || {};
  const own = ownMaterialPublicId(body.ticket || body.publicId, req.user._id);
  if (!own) return res.status(400).json({ ok: false, message: "这份教材不是本账号传的（或者地址被改过）" });
  const sha = String(body.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) return res.status(400).json({ ok: false, message: "缺 sha256（浏览器算的 64 位十六进制）" });
  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (!pages.every((p) => Number.isInteger(p.idx) && Array.isArray(p.blocks) && p.blocks.every((b) => typeof b.text === "string" && /^[0-9a-f]{12}$/.test(String(b.hash || ""))))) return res.status(400).json({ ok: false, message: "pages 形状不对：每页 { idx, title?, blocks[{ hash(12 hex), text, bbox? }] }" });
  // 同 sha 已在 → duplicate（不去 Cloudinary 核对：字节早就在了；这一发传上来的副本随后回收）
  const existing = (await ctx.materials()).find((m) => m.sha === sha);
  if (existing) {
    if (cloudinaryReady()) cloudinary.uploader.destroy(own.publicId, { resource_type: "raw" }).catch((e) => console.error(`[tutor] 重复教材回收失败 ${own.publicId}:`, (e && e.message) || e));
    return res.json({ ok: true, duplicate: true, material: existing, message: "这份文件已经在这门课里（按 sha256 去重，不重复解析、不重复计费）" });
  }
  let resource = null;
  if (cloudinaryReady()) {
    try { resource = await cloudinary.api.resource(own.publicId, { resource_type: "raw" }); } catch (e) {
      const code = (e && e.error && e.error.http_code) || (e && e.http_code);
      if (code === 404) return res.status(409).json({ ok: false, message: "字节还没传上来（先把文件传完再 confirm）", code: "NOT_UPLOADED" });
      console.error(`[tutor] 教材直传验收取资源失败 ${own.publicId}:`, (e && e.message) || e);
      return res.status(502).json({ ok: false, message: "文件存储暂时取不到这份教材的信息，请稍后重试。" });
    }
    const bytes = Number(resource && resource.bytes) || 0;
    if (bytes > maxBytes()) { cloudinary.uploader.destroy(own.publicId, { resource_type: "raw" }).catch(() => {}); return res.status(413).json({ ok: false, message: `教材最大 ${Math.round(maxBytes() / 1024 / 1024)}MB（这份约 ${Math.round(bytes / 1024 / 1024)}MB）`, code: "TOO_LARGE" }); }
  } else if (process.env.NODE_ENV === "production") return res.status(503).json({ ok: false, message: "服务器还没配好文件存储，暂时不能上传教材。" });
  const r = await ctx.addMaterial({ name: String(body.name || `material.${own.ext}`), sha, ext: own.ext, bytes: Number((resource && resource.bytes) || body.bytes || 0), pages, license: body.license, warnings: body.warnings, publicId: resource ? own.publicId : "" });
  const material = (await ctx.materials()).find((m) => m.sha === sha) || null;
  if (r.duplicate) return res.json({ ok: true, duplicate: true, material, message: "这份文件已经在这门课里（按 sha256 去重，不重复解析、不重复计费）" });
  return res.status(201).json({ ok: true, duplicate: false, material });
}
/** GET /materials/:sha/file：原件私有（raw 公开投递 401），由服务端签一个 5 分钟的下载地址转过去 */
function materialFileUrl(material) {
  if (!material.publicId || !cloudinaryReady()) return null;
  return directDownloadUrl("raw", material.publicId, 300);
}

// ---- 生成作业（受理即扣、worker 跑）
async function startGenerate(ctx, user, questionnaire) {
  if (!aiConfig() && !demoAllowed()) return { status: 501, body: { ok: false, code: "AI_NOT_CONFIGURED", message: "服务器还没配模型，暂时不能生成老师" } };
  const mats = await ctx.materialsWithPages();
  if (!mats.length) return { status: 400, body: { ok: false, message: "这门课还没有抽出文字的教材，先传一份", code: "NO_MATERIALS" } };
  const running = await TutorJob.findOne({ course: ctx.course._id, status: { $in: ["pending", "running"] } });
  if (running) return { status: 409, body: { ok: false, message: "这门课正在生成，等它跑完", code: "BUSY", jobId: String(running._id) } };
  const plan = planGenerate(mats);
  const q = { name: String(questionnaire.name).trim().slice(0, 40), style: questionnaire.style, catchphrase: questionnaire.catchphrase, strictness: questionnaire.strictness, address: questionnaire.address, examples_from: questionnaire.examples_from, extra_rules: Array.isArray(questionnaire.extra_rules) ? questionnaire.extra_rules : [] };
  let job;
  if (aiConfig()) {
    // $ tutor_extract × N：受理那一拍扣整份报价（docs/05 §4.8）；建不出作业才退
    const r = await billing.chargedCall({ user, cost: plan.quote.total, memo: `tutor_generate ${ctx.id} ${plan.quote.total}`, refundTag: "tutor_refund", forward: async () => { job = await TutorJob.create({ course: ctx.course._id, owner: user._id, questionnaire: q, progress: { step: "queued", done: 0, total: 1, message: "排队中", mode: "model" } }); return { accepted: true }; } });
    if (!r.ok) return { status: r.status, body: r.body, wallet: r.wallet };
    return { status: 202, body: { ok: true, jobId: String(job._id), quote: plan.quote, nameHint: realNameHint(q.name) }, wallet: r.wallet };
  }
  job = await TutorJob.create({ course: ctx.course._id, owner: user._id, questionnaire: q, progress: { step: "queued", done: 0, total: 1, message: "排队中", mode: "demo" } });
  return { status: 202, body: { ok: true, jobId: String(job._id), quote: plan.quote, nameHint: realNameHint(q.name) } };
}
const jobView = (j) => ({ id: String(j._id), kind: j.kind, courseId: String(j.course), status: j.status, progress: j.progress, result: j.result || null, error: j.error || null, failures: j.failures || [], startedAt: (j.startedAt || j.createdAt).toISOString(), finishedAt: j.finishedAt ? j.finishedAt.toISOString() : undefined });

/** worker 的一步：抢一个 pending 作业跑完。回 null = 没有作业。测试也直接调它（不起轮询）。 */
async function runNextJob() {
  const job = await TutorJob.findOneAndUpdate({ status: "pending", attempts: { $lt: 3 } }, { $set: { status: "running", startedAt: new Date() }, $inc: { attempts: 1 } }, { returnDocument: "after" });
  if (!job) return null;
  try {
    const ctx = await CourseCtx.load(job.course, { _id: job.owner });
    if (!ctx) throw new Error("课程不在了");
    const mats = await ctx.materialsWithPages();
    const checkpoint = { read: () => job.checkpoint || null, write: (o) => { job.checkpoint = o; job.markModified("checkpoint"); TutorJob.updateOne({ _id: job._id }, { $set: { checkpoint: o } }).catch(() => {}); }, clear: () => { job.checkpoint = undefined; } };
    let lastTick = 0;
    const out = await runGenerate({
      course: ctx.meta, materials: mats.map((m) => ({ sha: m.sha, name: m.name, ext: m.ext, pages: m.pages, license: m.license })), questionnaire: job.questionnaire,
      checkpoint, onProgress: (p) => { job.progress = p; const now = Date.now(); if (now - lastTick > 500) { lastTick = now; TutorJob.updateOne({ _id: job._id }, { $set: { progress: p } }).catch(() => {}); } },
      // ★ 用 ?. 不用 &&：还没生成过的课 ctx.doc 是 null，`null && …` 得 null，而 seedDoc 的 `id = newDocId()` 只对 undefined 生效 →
      //   文档 id 为 null、组装校验整份拒，任务 3 次后 failed、受理时扣的报价不退（2026-09-30 本机首跑 tutorBilling.spec 才发现；参考实现一直是 ?.）
      docId: ctx.doc?.id, version: (ctx.doc?.version || 0) + 1, supersedes: ctx.doc?.version,
      author: { username: "author", uid: 0 }, env: { ...process.env, TUTOR_META_USER: String(job.owner) },
    });
    await ctx.writePersona(out.text, { provenance: { method: out.mode === "demo" ? "demo" : "model", calls: out.calls, mode: out.mode } });
    job.result = { personaId: out.doc.id, version: out.doc.version, stages: out.doc.map.stages.length, mode: out.mode, calls: out.calls, warnings: out.warnings, sections: out.sections, anchors: out.anchors };
    job.failures = out.failures;
    job.status = "succeeded";
    job.checkpoint = undefined;
  } catch (e) {
    job.status = job.attempts >= 3 ? "failed" : "pending"; // 没到上限就放回去等下一轮（检查点还在，不重扣已完成块）
    job.error = e.message;
    if (job.status === "failed") console.error(`[tutor] generate ${job.course} 失败:`, e.stack || e.message);
  } finally {
    job.finishedAt = ["succeeded", "failed"].includes(job.status) ? new Date() : undefined;
    job.markModified("progress"); job.markModified("result"); job.markModified("checkpoint");
    await job.save();
  }
  return job;
}

// ---- 扫描目录（清单里还没进 ③ 的教材 → 阶段提议 → 点头追加）
const pendingScans = new Map(); // patchId → { courseId, proposals, materials, at }（进程内：提议是一次性的，重启后重扫即可）
async function handleScan(ctx, user, res) {
  const fresh = (await ctx.materialsWithPages()).filter((m) => !m.inDoc);
  if (!fresh.length) return res.json({ ok: true, proposals: [], patchId: null, message: "没有新教材" });
  if (!aiConfig() && !demoAllowed()) return res.status(501).json({ ok: false, code: "AI_NOT_CONFIGURED", message: "服务器还没配模型" });
  const { sections } = planGenerate(fresh);
  const preset = presetOf(undefined);
  const failures = [];
  const ck = { stages: null, distills: {}, calls: 0 };
  const run = () => proposeStages({ sections, materials: fresh, teacherName: ctx.doc.name, subject: ctx.doc.subject, courseTitle: ctx.meta.title, styleText: ctx.doc.card.teaching_style, preset, existing: ctx.doc.map.stages.map((s) => s.title), env: process.env, mode: modeNow(), ck, save: () => {}, pagesBySha: Object.fromEntries(fresh.map((m) => [m.sha, m.pages])), failures, tick: () => {} });
  if (aiConfig()) {
    // $ tutor_extract × 新教材数（建议值：阶段数在跑完前不知道；生成那条路是整份报价）
    const r = await billing.chargedCall({ user, cost: priceOf("tutor_extract") * fresh.length, memo: `tutor_scan ${ctx.id} ${fresh.length}`, refundTag: "tutor_refund", forward: async () => { await run(); return { accepted: true }; } });
    if (!r.ok) return res.status(r.status).json(r.body);
  } else await run();
  const proposals = ck.stages.map((st, k) => ({ value: { week: st.week ?? "", title: st.title, summary: st.summary || "", distill: ck.distills[String(k)] }, rationale: `新教材 ${fresh.map((m) => m.name).join("、")}` }));
  const patchId = crypto.randomBytes(6).toString("hex");
  pendingScans.set(patchId, { courseId: ctx.id, userId: String(user._id), proposals, materials: fresh.map((m) => m.sha), at: Date.now() });
  for (const [k, v] of pendingScans) if (Date.now() - v.at > 6 * 3600_000) pendingScans.delete(k);
  return res.json({ ok: true, patchId, failures, materials: fresh.map((m) => ({ sha: m.sha, name: m.name })), proposals: proposals.map((p, i) => ({ i, title: p.value.title, summary: p.value.summary, steps: (p.value.distill.walkthrough && p.value.distill.walkthrough.length) || 0, memo: p.value.distill.must_memorize.length, checks: p.value.distill.self_checks.length, method: p.value.distill.method })) });
}
async function handleAccept(ctx, user, res, patchId, body) {
  const pend = pendingScans.get(patchId);
  if (!pend || pend.courseId !== ctx.id || pend.userId !== String(user._id)) return res.status(404).json({ ok: false, message: "没有这批提议（重新扫描一次）" });
  const pick = Array.isArray(body.indices) ? body.indices : pend.proposals.map((_, i) => i);
  const chosen = pend.proposals.filter((_, i) => pick.includes(i));
  const ops = chosen.map((p) => ({ op: "map.stage.propose", path: "/map/stages", value: p.value, evidence: [], rationale: p.rationale }));
  const v = ops.length ? validateOpsBatch(ops, { source: "scan", runId: ctx.doc.id, doc: ctx.doc }) : { ok: true, ops: [] };
  if (!v.ok) return res.status(400).json({ ok: false, message: `提议整批被拒：${v.errors.join("；")}` });
  const { doc: next, results } = await applyOps(ctx.doc, v.ops, { confirm: async () => true });
  next.map.source_material_hashes = [...new Set([...(next.map.source_material_hashes || []), ...pend.materials.map((s) => `sha256:${s}`)])];
  if (chosen.length) CourseCtx.bumpVersion(next, `扫描目录追加 ${chosen.length} 个阶段`);
  await appendRevision(ctx.revisionStore(), { kind: "scan", ops: results, summary: `作者点头 ${chosen.length} / ${pend.proposals.length} 个提议`, by: "user", source: { materials: pend.materials.map((s) => `sha256:${s}`), patchId } });
  try { await ctx.persistDoc(next); } catch (e) { return res.status(500).json({ ok: false, message: e.message }); }
  const fresh = await CourseCtx.load(ctx.id, user); // 进度按新地图补 pending（等价于 store.js 的 reload）
  pendingScans.delete(patchId);
  return res.json({ ok: true, added: results.filter((r) => r.status === "applied").map((r) => r.created), version: fresh.doc.version, stages: fresh.doc.map.stages.length });
}

module.exports = { demoAllowed, quoteOf, handleSign, handleConfirm, materialFileUrl, ownMaterialPublicId, startGenerate, runNextJob, jobView, handleScan, handleAccept, hardRulesFrom, MATERIAL_FOLDER };
