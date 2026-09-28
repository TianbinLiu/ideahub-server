"use strict";
/**
 * 老师人格的发布（docs/02 §6、docs/06 §4.1）：五道门 → 铸发布版快照（TutorRelease）→ Persona{kind:"tutor", shared:true}。
 *
 * ★ 五道门只在 checkGates 一处（服务端）；客户端的灰按钮只是把它的答案画出来。任一不过整句拒并指明是哪一道（回包 gate 字段），顺序：
 *   ① 教材授权：参与的全部教材 license.source ≠ unsure（文档头那格也重算过）
 *   ② 泄漏核查：cleanCheck（与「导出发布件」同一份 core/export.buildExport；没有教材文本 = 没查过 = 不许发）
 *   ③ 成人声明：User.tutorAdultDeclaredAt
 *   ④ 主动声明含 AI 生成内容：body.aigcDeclared === true（《标识办法》第十条，显式勾选不是脚注）
 *   ⑤ 化名：realNameHint 认不出真实教授姓名；tags ≤ 6。分类锁 teaching：服务端写死，客户端没有这个字段。
 * ★ 发布件 = applyAudience("market") 裁过的文档（② 只带种子、学生问答不带、③ 状态列清空）—— 导出能发出去的，市场也能发；导出被拒的，市场同样拒。
 * ★ 一门课 = 一位老师 = 一条 Persona（course 上 partial unique）；再次发布 = 新版本（TutorRelease v(n+1)），旧版快照原样留着，已开的 Run 钉在旧版。
 * ★ 被平台下架的老师不能再发布（docs/02 6.6）；取消分享（unpublish）只翻 shared，快照与版号都留着。
 */
const Persona = require("../models/Persona");
const TutorRelease = require("../models/TutorRelease");
const User = require("../models/User");
const { buildExport } = require("../tutor/core/export/index");
const { realNameHint } = require("../tutor/core/generate/demo");
const { sha256Hex } = require("../tutor/core/format/index");

const TAGS_MAX = 6;
const TAG_MAX_LEN = 20;
const DEFAULT_COVER = "🎓";

/** 纯函数那一半：给什么判什么，不查库（spec 直接喂假 ctx）。回 { ok:false, gate, message, details? } 或 { ok:true, built, name, tags }。 */
function checkGates({ doc, materials, materialTexts, adultDeclared, body = {}, now = new Date() }) {
  if (!doc) return { ok: false, gate: "persona", message: "这门课还没有老师（先生成）" };
  const name = String(body.name ?? doc.name ?? "").trim().slice(0, 120);
  const tags = [...new Set((Array.isArray(body.tags) ? body.tags : []).map((t) => String(t).trim().toLowerCase().slice(0, TAG_MAX_LEN)).filter(Boolean))];
  if (tags.length > TAGS_MAX) return { ok: false, gate: "tags", message: `标签最多 ${TAGS_MAX} 个，给了 ${tags.length} 个` };
  // ① 授权
  const mats = Array.isArray(materials) ? materials : [];
  if (!mats.length) return { ok: false, gate: "license", message: "这门课还没有教材，没有可发布的老师" };
  const unsure = mats.filter((m) => (m.license && m.license.source) === "unsure");
  if (unsure.length) return { ok: false, gate: "license", message: `有 ${unsure.length} 份教材的授权来源还是「不确定」：${unsure.map((m) => m.name).join("、")}。先在课程页把每一份改成确定的来源`, details: { unsure: unsure.map((m) => m.sha) } };
  if (doc.license && doc.license.source === "unsure") return { ok: false, gate: "license", message: "文档头的授权来源还是「不确定」，改一份教材的来源就会重算" };
  // ② 泄漏核查（最贵的一道放第二：授权不过时不必白算）
  const texts = Array.isArray(materialTexts) ? materialTexts.filter((t) => t && t.text) : [];
  if (!texts.length) return { ok: false, gate: "cleanCheck", message: "这门课没有教材文本，泄漏核查没法跑 —— 发布前必须查过（先登记有块级文本的教材）" };
  const built = buildExport(doc, { audience: "market", materials: texts, now });
  if (!built.ok) return { ok: false, gate: built.code === "CLEAN_CHECK" ? "cleanCheck" : "doc", message: built.message, ...(built.clean ? { details: { clean: built.clean } } : {}) };
  // ③ 成人声明
  if (!adultDeclared) return { ok: false, gate: "adult", message: "先做成人声明（落地页第一次进来那一步）再发布" };
  // ④ 主动声明
  if (body.aigcDeclared !== true) return { ok: false, gate: "aigc", message: "发布前要主动声明「这位老师含 AI 生成内容」—— 勾上那一项（《标识办法》第十条）" };
  // ⑤ 化名
  if (!name) return { ok: false, gate: "name", message: "老师得有个名字" };
  const hint = realNameHint(name);
  if (hint) return { ok: false, gate: "name", message: hint };
  return { ok: true, built, name, tags };
}

function publishView(p, rel) {
  return {
    personaId: String(p._id), name: p.name, description: p.description || "", tags: p.tags || [], coverEmoji: p.coverEmoji || DEFAULT_COVER, subject: p.subject || "",
    shared: !!p.shared, takenDown: !!p.takenDown, ...(p.takenDown ? { takenDownReason: p.takenDownReason || "" } : {}),
    version: rel ? rel.version : p.releaseVersion || 0, sha256: rel ? rel.sha256 : undefined, checksum: rel ? rel.checksum : undefined, produceId: rel ? rel.produceId : undefined,
    publishedAt: rel ? rel.publishedAt : undefined, aigcDeclaredAt: p.aigcDeclaredAt || null, marketPath: `/tutor/market/${String(p._id)}`,
  };
}

async function publish(ctx, user, body = {}) {
  const [materials, materialTexts, u] = await Promise.all([ctx.materials(), ctx.materialTextsForCheck(), User.findById(user._id).select("tutorAdultDeclaredAt").lean()]);
  const g = checkGates({ doc: ctx.doc, materials, materialTexts, adultDeclared: !!(u && u.tutorAdultDeclaredAt), body });
  if (!g.ok) return { status: 422, body: { ok: false, code: "GATE", gate: g.gate, message: g.message, ...(g.details ? { details: g.details } : {}) } };
  const existing = await Persona.findOne({ kind: "tutor", course: ctx.course._id });
  if (existing && existing.takenDown) return { status: 403, body: { ok: false, code: "TAKEN_DOWN", message: `这位老师已被平台下架（${existing.takenDownReason || "原因见站内通知"}），不能再发布` } };
  const last = await TutorRelease.findOne({ course: ctx.course._id }).sort({ version: -1 }).select("version").lean();
  const version = ((last && last.version) || 0) + 1;
  const fields = {
    kind: "tutor", author: user._id, course: ctx.course._id, name: g.name,
    description: String(body.description ?? (existing && existing.description) ?? "").trim().slice(0, 1000),
    coverEmoji: String(body.coverEmoji || (existing && existing.coverEmoji) || DEFAULT_COVER).slice(0, 8),
    tags: g.tags.length ? g.tags : (existing && existing.tags) || [],
    subject: ctx.meta.subject, shared: true, aigcDeclaredAt: new Date(),
    license: { source: (ctx.doc.license && ctx.doc.license.source) || "" }, policy: ctx.meta.policy, releaseVersion: version,
  };
  const persona = existing || new Persona({ price: 0 });
  Object.assign(persona, fields);
  await persona.save();
  const rel = await TutorRelease.create({
    persona: persona._id, course: ctx.course._id, owner: user._id, version, personaId: ctx.doc.id, name: g.name,
    doc: g.built.doc, text: g.built.text, checksum: g.built.checksum, sha256: sha256Hex(g.built.text), produceId: (g.built.doc.AIGC && g.built.doc.AIGC.ProduceID) || "",
    stages: g.built.doc.map.stages.length, note: String(body.note || "").trim().slice(0, 200),
  });
  persona.currentDoc = rel._id;
  await persona.save();
  return { status: 201, body: { ok: true, persona: publishView(persona, rel), warnings: g.built.warnings || [] } };
}

/** 取消分享：只翻 shared；快照、版号、评论都留着（再发布是 v(n+1)） */
async function unpublish(ctx) {
  const p = await Persona.findOneAndUpdate({ kind: "tutor", course: ctx.course._id }, { $set: { shared: false } }, { returnDocument: "after" });
  if (!p) return { status: 404, body: { ok: false, message: "这门课还没发布过" } };
  const rel = p.currentDoc ? await TutorRelease.findById(p.currentDoc).lean() : null;
  return { status: 200, body: { ok: true, persona: publishView(p, rel) } };
}

/** 课程页 / 课程列表要的发布状态（summary 里的 published 那一格） */
async function publishState(courseId) {
  const p = await Persona.findOne({ kind: "tutor", course: courseId }).lean();
  if (!p) return null;
  const rel = p.currentDoc ? await TutorRelease.findById(p.currentDoc).select("version sha256 checksum produceId publishedAt").lean() : null;
  return publishView(p, rel);
}

module.exports = { checkGates, publish, unpublish, publishState, publishView, TAGS_MAX, DEFAULT_COVER };
