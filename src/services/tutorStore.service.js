// src/services/tutorStore.service.js
// 老师人格的「课程上下文」：tutor 仓 src/server/store.js 里的 Course / Store 换成 Mongo（docs/04 §5 S24 / S25 / S26）。
// 方法名与那边一一对应（materials / pagesOf / addMaterial / persistDoc / applyAdvance / nextSeq / logTurn / readTurns / revisions …），
// 所以 tutorSession / tutorDistill / tutorDoc / tutorAi 四个 service 是照着 devServer.mjs 的参考实现逐段搬的，规则一个字没改：
//   · 只有 core/session/progress.js 的 advance() 翻阶段状态（applyAdvance 是它唯一的调用口）；
//   · 头文档（TutorDoc）永远是自用件；每次改动都过 validateTutorDoc，不合规范整句拒、不落库；
//   · 修订记录 append-only（TutorRevision），review / revert 只改原记录里 op 的 status。
// ★ 一门课 = 一位老师 = 一个 Run（作者本人的）：M1 只有作者自己学（docs/06 §3.1），Run 的 id 对外就是课程 id（客户端 /runs/:id 传的是课程 id）。
// ★ 所有入口都先 load(courseId, user)：不是本人的课一律 404（不泄露存在性），与 branchVideo 对私有作品的口径相同。
const mongoose = require("mongoose");
const TutorCourse = require("../models/TutorCourse");
const TutorMaterial = require("../models/TutorMaterial");
const TutorChunk = require("../models/TutorChunk");
const TutorDoc = require("../models/TutorDoc");
const TutorRun = require("../models/TutorRun");
const TutorTurn = require("../models/TutorTurn");
const TutorRevision = require("../models/TutorRevision");
const TutorExport = require("../models/TutorExport");
const { parseTutorDoc, renderTutorDoc, validateTutorDoc, expectedProduceId } = require("../tutor/core/format/index");
const { POLICY_AI, HOMEWORK_MODES, LICENSE_SOURCES, KEY_DATE_KINDS } = require("../tutor/core/format/constants");
const { pagesToText, shortSha } = require("../tutor/core/materials/blocks");
const { nextReviewAt, initProgress, advance, progressToDoc, runStatusOf, dueReviews } = require("../tutor/core/session/index");
const { pendingOps } = require("../tutor/core/ops/revision");
const { licenseSourceOf } = require("../tutor/core/generate/assemble");

const SUPPORTED_FORMATS = ["pdf", "pptx", "docx", "md", "txt"];

/** 建课字段校验（docs/02 1.2：缺任一必填 400 并指名字段）—— 与 tutor 仓 store.js 同一份 */
function validateCourseInput(b) {
  if (!b || typeof b !== "object") return { field: "body", message: "请求体要是 JSON 对象" };
  if (!String(b.title || "").trim()) return { field: "title", message: "缺必填字段：title（课程标题）" };
  if (!String(b.subject || "").trim()) return { field: "subject", message: "缺必填字段：subject（学科）" };
  const p = b.policy || {};
  if (!POLICY_AI.includes(p.ai)) return { field: "policy.ai", message: `policy.ai 必须是 ${POLICY_AI.join(" / ")} 之一` };
  if (!HOMEWORK_MODES.includes(p.homework_mode)) return { field: "policy.homework_mode", message: `policy.homework_mode 必须是 ${HOMEWORK_MODES.join(" / ")} 之一` };
  for (const d of b.key_dates || []) {
    if (!String((d && d.label) || "").trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String((d && d.at) || ""))) return { field: "key_dates", message: "关键日期每条要有 label 与 YYYY-MM-DD 的 at" };
    if (d.kind && !KEY_DATE_KINDS.includes(d.kind)) return { field: "key_dates", message: `关键日期 kind 只能是 ${KEY_DATE_KINDS.join(" / ")}` };
  }
  return null;
}
function normalizeCourseInput(b) {
  return {
    title: String(b.title).trim().slice(0, 120), subject: String(b.subject).trim().slice(0, 60),
    ...(b.code ? { code: String(b.code).trim().slice(0, 60) } : {}), ...(b.term ? { term: String(b.term).trim().slice(0, 40) } : {}),
    policy: { ai: b.policy.ai, homework_mode: b.policy.homework_mode, allowed_uses: (b.policy.allowed_uses || []).map((x) => String(x).slice(0, 60)).slice(0, 12), text: String(b.policy.text || "").slice(0, 2000) },
    key_dates: (b.key_dates || []).map((d) => ({ label: String(d.label).trim().slice(0, 60), at: String(d.at), kind: KEY_DATE_KINDS.includes(d.kind) ? d.kind : "other" })).slice(0, 30),
  };
}
const plainMeta = (c) => ({ id: String(c._id), title: c.title, subject: c.subject, code: c.code || undefined, term: c.term || undefined, policy: { ai: c.policy?.ai || "limited", homework_mode: c.policy?.homework_mode || "principles_only", allowed_uses: c.policy?.allowed_uses || [], text: c.policy?.text || "" }, key_dates: (c.key_dates || []).map((d) => ({ label: d.label, at: d.at, kind: d.kind || "other" })), createdAt: c.createdAt?.toISOString?.() || c.createdAt, updatedAt: c.updatedAt?.toISOString?.() || c.updatedAt, importedFromPersona: !!c.importedFromPersona });
function metaFromDoc(doc) {
  return { title: doc.course?.title || doc.subject, subject: doc.subject, ...(doc.course?.code ? { code: doc.course.code } : {}), ...(doc.course?.term ? { term: doc.course.term } : {}), policy: { ai: doc.policy?.ai || "limited", homework_mode: doc.policy?.homework_mode || "principles_only", allowed_uses: doc.policy?.allowed_uses || [], text: doc.policy?.text || "" }, key_dates: doc.map.key_dates || [], importedFromPersona: true };
}

class CourseCtx {
  constructor({ course, user, docRec, run }) {
    this.course = course; this.user = user; this.docRec = docRec || null; this.run = run || null;
    this.meta = plainMeta(course);
    this.doc = docRec ? docRec.doc : null;
  }
  get id() { return String(this.course._id); }
  get hasPersona() { return !!this.doc; }

  /**
   * 取一门课 + 头文档 + 作者 Run。不是本人的课回 null（404）。
   * 有头文档就保证 Run 存在，并像 store.js 的 reload() 那样：进度按 ③ 起手、多出来的阶段补 pending、status 重算。
   */
  static async load(courseId, user) {
    if (!mongoose.isValidObjectId(courseId)) return null;
    const course = await TutorCourse.findOne({ _id: courseId, owner: user._id });
    if (!course) return null;
    const docRec = await TutorDoc.findOne({ course: course._id });
    let run = null;
    if (docRec) {
      run = await TutorRun.findOne({ course: course._id, user: user._id });
      if (!run) run = await TutorRun.create({ course: course._id, user: user._id, progress: initProgress(docRec.doc, {}), status: runStatusOf(docRec.doc, initProgress(docRec.doc, {})) });
      const progress = initProgress(docRec.doc, run.progress || {});
      const status = runStatusOf(docRec.doc, progress);
      if (JSON.stringify(progress) !== JSON.stringify(run.progress || {}) || status !== run.status) {
        run.progress = progress; run.status = status; run.markModified("progress");
        await run.save();
      }
    }
    return new CourseCtx({ course, user, docRec, run });
  }
  static async listForUser(user) {
    const courses = await TutorCourse.find({ owner: user._id }).sort({ updatedAt: -1 });
    const out = [];
    for (const c of courses) { const ctx = await CourseCtx.load(c._id, user); if (ctx) out.push(ctx); }
    return out;
  }
  static async create(user, input) {
    const course = await TutorCourse.create({ owner: user._id, ...input });
    return CourseCtx.load(course._id, user);
  }
  /** 从一份导入的人格文档新开一门课（docs/02 5.5）：course 信息从 frontmatter 派生，persona 由调用方随后 writePersona */
  static async createFromDoc(user, doc) {
    const course = await TutorCourse.create({ owner: user._id, ...metaFromDoc(doc) });
    return CourseCtx.load(course._id, user);
  }
  async updateMeta(patch) {
    const next = normalizeCourseInput({ ...this.meta, ...patch, policy: { ...this.meta.policy, ...(patch.policy || {}) } });
    Object.assign(this.course, next);
    await this.course.save();
    this.meta = plainMeta(this.course);
    return this.meta;
  }

  // ---- 教材（TutorMaterial / TutorChunk）
  async materials() {
    const hashes = new Set(this.doc?.map?.source_material_hashes || []);
    const rows = await TutorMaterial.find({ course: this.course._id }).sort({ createdAt: 1 }).lean();
    return rows.map((m) => ({
      sha: m.sha, short: shortSha(m.sha), name: m.name, ext: m.ext, units: m.units, chars: m.chars, bytes: m.bytes, addedAt: m.createdAt?.toISOString?.() || m.createdAt,
      license: { source: LICENSE_SOURCES.includes(m.license?.source) ? m.license.source : "unsure" },
      parsed: m.parsed || { status: "pending", chars: m.chars, warnings: [] },
      present: !!m.publicId, inDoc: hashes.has(`sha256:${m.sha}`),
      url: `/api/tutor/materials/${m.sha}/file`, textUrl: `/api/tutor/materials/${m.sha}/text`,
    }));
  }
  /** sha 全长或 ≥12 位前缀 */
  async findMaterial(key) {
    const k = String(key || "").toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(k)) return null;
    return TutorMaterial.findOne(k.length === 64 ? { course: this.course._id, sha: k } : { course: this.course._id, sha: { $regex: `^${k}` } });
  }
  async pagesOf(material) {
    if (!material) return null;
    const rows = await TutorChunk.find({ material: material._id }).sort({ idx: 1 }).lean();
    if (!rows.length) return null;
    return rows.map((p) => ({ idx: p.idx, ...(p.title ? { title: p.title } : {}), blocks: (p.blocks || []).map((b) => ({ hash: b.hash, text: b.text, ...(b.bbox && b.bbox.length ? { bbox: b.bbox } : {}) })) }));
  }
  async materialsWithPages() {
    const list = await this.materials();
    const out = [];
    for (const m of list) { const mat = await TutorMaterial.findOne({ course: this.course._id, sha: m.sha }); const pages = (await this.pagesOf(mat)) || []; if (pages.length) out.push({ ...m, pages }); }
    return out;
  }
  /** 浏览器直传 + 抽好的 pages 入库（D3：服务端不解析）。同 sha 已在 → duplicate。 */
  async addMaterial({ name, sha, ext, bytes, pages, license, warnings, publicId }) {
    const dup = await TutorMaterial.findOne({ course: this.course._id, sha });
    if (dup) return { duplicate: true, sha };
    const text = pagesToText(pages);
    const chars = text.replace(/\s+/g, "").length;
    const material = await TutorMaterial.create({
      course: this.course._id, sha, name: String(name).slice(0, 200), ext: String(ext || "").toLowerCase().replace(/^\.?/, "."), bytes: Number(bytes) || 0, units: pages.length, chars,
      license: { source: LICENSE_SOURCES.includes(license?.source) ? license.source : "unsure" },
      parsed: { status: chars > 0 ? "ok" : "failed", chars, sections: pages.length, warnings: (warnings || []).slice(0, 10).map((w) => String(w).slice(0, 300)) },
      publicId: publicId || "", from: "browser",
    });
    if (pages.length) await TutorChunk.insertMany(pages.map((p) => ({ course: this.course._id, material: material._id, sha, idx: p.idx, title: p.title, blocks: p.blocks })), { ordered: true });
    return { duplicate: false, sha };
  }
  /**
   * 事后改一份教材的授权来源（上传时选了「不确定」、后来问到教授了）。同 sha 再传会被去重、那一发带的 license 不算数，所以必须有这一条
   * （tutor 仓 2026-09-27 dogfood 撞到）。文档头 license.source 跟着**全体**教材重算（取最差），否则导出时 validate 照旧按旧值拒。只改 frontmatter，不算一版。
   */
  async setMaterialLicense(material, source) {
    if (!LICENSE_SOURCES.includes(source)) throw new Error(`授权来源只能是 ${LICENSE_SOURCES.join(" / ")}`);
    material.license = { source };
    await material.save();
    if (this.doc) {
      const docSource = licenseSourceOf(await this.materials());
      if (docSource !== this.doc.license?.source) { const next = JSON.parse(JSON.stringify(this.doc)); next.license = { ...(next.license || {}), source: docSource }; await this.persistDoc(next); }
    }
    return { sha: material.sha, license: { source }, docLicense: this.doc?.license?.source ?? null };
  }
  /** 给泄漏核查用的教材全文（有块级文本的教材） */
  async materialTextsForCheck() {
    const mats = await TutorMaterial.find({ course: this.course._id }).lean();
    const out = [];
    for (const m of mats) { const pages = await this.pagesOf(m); if (pages) out.push({ name: m.name, text: pagesToText(pages) }); }
    return out;
  }

  // ---- 人格（TutorDoc）
  /** 版次 +1（点头一批 / 扫描点头）。★ ProduceID 是 tutor:<id>:v<version> 的 uuid v5，版次变了必须重算，否则 persistDoc 整句拒 */
  static bumpVersion(next, note) { next.supersedes = next.version; next.version += 1; next.version_note = note; next.AIGC = { ...(next.AIGC || {}), ProduceID: expectedProduceId(next) }; return next; }
  async persistDoc(next) {
    if (next.audience !== "self") { next.audience = "self"; next.includes_student_profile = "full"; }
    const v = validateTutorDoc(next, { requireLabels: false });
    if (!v.ok) throw new Error(`不存：改完的文档不合规范：${v.errors.join("；")}`);
    const { text, checksum } = renderTutorDoc(next);
    const patch = { owner: this.user._id, personaId: next.id, version: next.version, name: next.name, text, doc: next, checksum, produceId: next.AIGC?.ProduceID || "" };
    this.docRec = await TutorDoc.findOneAndUpdate({ course: this.course._id }, { $set: patch }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true });
    this.doc = next;
    if (!this.run) { this.run = await TutorRun.findOne({ course: this.course._id, user: this.user._id }) || (await TutorRun.create({ course: this.course._id, user: this.user._id, progress: initProgress(next, {}), status: runStatusOf(next, initProgress(next, {})) })); }
    return v.warnings;
  }
  /** 整份 .md 写进来（生成 / 导入）：解析 → 存 → 进度按 ③ 起手（等价于 store.js 的 writePersona + reload） */
  async writePersona(text, extra = {}) {
    const { doc } = parseTutorDoc(text);
    await this.persistDoc(doc);
    if (extra.provenance) { this.docRec.provenance = extra.provenance; await this.docRec.save(); }
    const progress = initProgress(doc, this.run.progress || {});
    this.run.progress = progress; this.run.status = runStatusOf(doc, progress); this.run.markModified("progress");
    await this.run.save();
    return doc;
  }

  // ---- Run / Turn
  async persistRun() { this.run.markModified("progress"); this.run.markModified("distill"); await this.run.save(); }
  async nextSeq() {
    const r = await TutorRun.findOneAndUpdate({ _id: this.run._id }, { $inc: { turnSeq: 1 }, $set: { lastTurnAt: new Date() } }, { returnDocument: "after" });
    this.run.turnSeq = r.turnSeq; this.run.lastTurnAt = r.lastTurnAt;
    return r.turnSeq;
  }
  async logTurn(t) { await TutorTurn.create({ run: this.run._id, ...t, at: new Date(t.at || Date.now()) }); return t; }
  async readTurns() {
    const rows = await TutorTurn.find({ run: this.run._id }).sort({ seq: 1 }).lean();
    return rows.map(({ _id, run, at, ...t }) => { void _id; void run; const o = { ...t, at: at.toISOString() }; for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k]; return o; });
  }
  async setTurnFeedback(seq, value) { const r = await TutorTurn.updateOne({ run: this.run._id, seq }, { $set: { feedback: value } }); return r.matchedCount > 0; }
  async applyAdvance(event) {
    const r = advance(this.doc, this.run, event);
    if (r.error) return r;
    const wasDone = this.run.status === "done";
    this.run.progress = r.progress; this.run.status = r.status;
    if (r.status === "done" && !wasDone) this.run.doneAt = new Date();
    const nra = nextReviewAt(r.progress); this.run.nextReviewAt = nra ? new Date(nra) : null; // 回访到期的扫表键（TutorRun 那格注释）
    await this.persistRun();
    if (r.changed.length) await this.persistDoc(progressToDoc(this.doc, this.run.progress)); // ③ 状态列跟着写回自用件
    return r;
  }
  /** 「老师还在回上一句」的闸：原子抢占，抢不到回 false（同一 Run 同时只开一条流） */
  async acquire(flag) { const r = await TutorRun.findOneAndUpdate({ _id: this.run._id, [flag]: { $ne: true } }, { $set: { [flag]: true } }); return !!r; }
  async release(flag) { await TutorRun.updateOne({ _id: this.run._id }, { $set: { [flag]: false } }); }

  // ---- 修订记录（TutorRevision，append-only）
  revisionStore() {
    const runId = this.run._id;
    const toRec = (r) => { const { _id, run, seq, rid, ...rest } = r; void _id; void run; void seq; const rec = { id: rid, ...rest }; if (rec.of === undefined || rec.of === null) delete rec.of; return rec; };
    return {
      read: async () => (await TutorRevision.find({ run: runId }).sort({ seq: 1 }).lean()).map(toRec),
      append: async (rec) => { const last = await TutorRevision.findOne({ run: runId }).sort({ seq: -1 }).select("seq").lean(); const { id, ...rest } = rec; await TutorRevision.create({ run: runId, rid: id, seq: (last?.seq || 0) + 1, ...rest }); },
      write: async (all) => { // review / revert 改了原记录里 op 的 status（与 jsonl 整文件重写同义）：逐条按 rid 回写，新增的追加
        const existing = await TutorRevision.find({ run: runId }).select("rid seq").lean();
        const known = new Map(existing.map((r) => [r.rid, r.seq]));
        let seq = existing.reduce((m, r) => Math.max(m, r.seq), 0);
        for (const rec of all) { const { id, ...rest } = rec; if (known.has(id)) await TutorRevision.updateOne({ run: runId, rid: id }, { $set: rest }); else await TutorRevision.create({ run: runId, rid: id, seq: ++seq, ...rest }); }
      },
    };
  }
  async revisions() { return this.revisionStore().read(); }
  async pendingOps() { return pendingOps(await this.revisions()); }

  // ---- 导出留痕（TutorExport）
  async readExports() { const rows = await TutorExport.find({ course: this.course._id }).sort({ createdAt: 1 }).lean(); return rows.map(({ _id, course, user, xid, createdAt, updatedAt, ...r }) => { void _id; void course; void user; void createdAt; void updatedAt; return { id: xid, ...r }; }); }
  async logExport(rec) { const { id, ...rest } = rec; await TutorExport.create({ course: this.course._id, user: this.user._id, xid: id, ...rest }); return rec; }

  /** 这门课发成的那位老师（一门课一条 Persona{kind:tutor}）：形状与端点回包同一份（tutorPublish.publishView）。★ 延迟 require：tutorPublish 不引本文件，不成环，但放顶层会让模块装载顺序变得脆弱 */
  publishedView() { return require("./tutorPublish.service").publishState(this.course._id); }
  async summary() {
    const mats = await this.materials();
    const pending = this.doc ? (await this.pendingOps()).length : 0;
    return {
      ...this.meta, materials: mats.length,
      unsure: mats.filter((m) => m.license.source === "unsure").length,
      persona: this.doc ? { id: this.doc.id, name: this.doc.name, version: this.doc.version, stages: this.doc.map.stages.length, format: this.doc.format, generatedAt: this.doc.provenance?.generated_at, method: this.doc.provenance?.method } : null,
      publishable: !!this.doc && mats.length > 0 && !mats.some((m) => m.license.source === "unsure"),
      published: await this.publishedView(), // 发布状态（M2）：null = 没发布过；shared:false = 取消了分享；takenDown = 被平台下架（带原因）
      source: await require("./tutorMerge.service").sourceState(this.course), // 从市场「开始学」开出来的课：钉的版本 + 最新版 + updateAvailable（懒 require：tutorMerge 依赖本模块）
      run: this.doc ? {
        status: this.run.status,
        currentStage: this.doc.map.stages.find((s) => this.run.progress?.[s.stage_id]?.status !== "passed")?.stage_id ?? null,
        dueReviews: dueReviews(this.doc, this.run.progress).length,
        pendingReview: pending,
      } : null,
    };
  }
}

module.exports = { CourseCtx, SUPPORTED_FORMATS, validateCourseInput, normalizeCourseInput };
