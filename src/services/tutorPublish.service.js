"use strict";
/**
 * 老师人格的发布（docs/02 §6、docs/06 §4.1）：五道门 → 铸发布版快照（TutorRelease）→ Persona{kind:"tutor", shared:true}。
 *
 * ★ 五道门只在 core/publish.checkGates 一处（tutor 仓 src/publish 的移植件，参考实现同一份）；客户端的灰按钮只是把它的答案画出来。任一不过整句拒并指明是哪一道（回包 gate 字段），顺序：
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
const TutorCourse = require("../models/TutorCourse");
const notify = require("./tutorNotify.service");
const { sha256Hex } = require("../tutor/core/format/index");
// ★ 五道门与常量都从核心包来（tutor 仓 src/publish，port:server 转成 CJS）：参考实现（tutor 仓 devServer）与这里跑的是同一个函数，
//   e2e 在参考实现上验过的门，这里一道不差；改门先回 tutor 仓改、再重跑 port —— 别在这儿另抄一份（2026-09-28 之前这里确实有一份手抄的，已删）。
const { checkGates, forkIdOf, TAGS_MAX, DEFAULT_COVER } = require("../tutor/core/publish/index");

function publishView(p, rel, extra = {}) {
  const remix = p.remixOf ? { id: String(p.remixOf._id || p.remixOf), name: (p.remixOf && p.remixOf.name) || extra.remixName || "" } : null; // 血缘（docs/02 9.1「复刻链」）
  return {
    remixOf: remix,
    personaId: String(p._id), name: p.name, description: p.description || "", tags: p.tags || [], coverEmoji: p.coverEmoji || DEFAULT_COVER, subject: p.subject || "",
    shared: !!p.shared, takenDown: !!p.takenDown, ...(p.takenDown ? { takenDownReason: p.takenDownReason || "" } : {}),
    version: rel ? rel.version : p.releaseVersion || 0, sha256: rel ? rel.sha256 : undefined, checksum: rel ? rel.checksum : undefined, produceId: rel ? rel.produceId : undefined,
    publishedAt: rel ? rel.publishedAt : undefined, aigcDeclaredAt: p.aigcDeclaredAt || null, marketPath: `/tutor/market/${String(p._id)}`,
  };
}

async function publish(ctx, user, body = {}) {
  const [materials, materialTexts, u, last] = await Promise.all([ctx.materials(), ctx.materialTextsForCheck(), User.findById(user._id).select("tutorAdultDeclaredAt").lean(), TutorRelease.findOne({ course: ctx.course._id }).sort({ version: -1 }).select("version").lean()]);
  const version = ((last && last.version) || 0) + 1;
  // 「另存为我的人格」（docs/02 5.10、docs/03 §7.3）：从市场开出来的课发布 = 复刻件，同一套五道门；没有自己的教材时 ① ② 沿用当初复制的那一版（sourceRelease）；
  //   id 从课 id 确定性派生、版次从 1 起、fork_of 记血缘、Persona.remixOf 指回来源 —— 规则在核心包 checkGates 的 fork 支路
  let fork = null; let remixName = "";
  if (ctx.course.sourcePersona) {
    const [src, base] = await Promise.all([Persona.findById(ctx.course.sourcePersona).select("_id name").lean(), ctx.course.sourceRelease ? TutorRelease.findById(ctx.course.sourceRelease).select("doc").lean() : null]);
    remixName = (src && src.name) || "";
    const baseDoc = (base && base.doc) || null;
    fork = { newId: forkIdOf(String(ctx.course._id)), version, sourceId: (baseDoc && baseDoc.id) || ctx.doc.id, sourceDocVersion: (baseDoc && baseDoc.version) || null, license: (baseDoc && baseDoc.license) || ctx.doc.license || null, author: { username: user.username || "user", uid: 0 } };
  }
  const g = checkGates({ doc: ctx.doc, materials, materialTexts, adultDeclared: !!(u && u.tutorAdultDeclaredAt), body, fork });
  if (!g.ok) return { status: 422, body: { ok: false, code: "GATE", gate: g.gate, message: g.message, ...(g.details ? { details: g.details } : {}) } };
  const existing = await Persona.findOne({ kind: "tutor", course: ctx.course._id });
  if (existing && existing.takenDown) return { status: 403, body: { ok: false, code: "TAKEN_DOWN", message: `这位老师已被平台下架（${existing.takenDownReason || "原因见站内通知"}），不能再发布` } };
  const fields = {
    kind: "tutor", author: user._id, course: ctx.course._id, name: g.name,
    description: String(body.description ?? (existing && existing.description) ?? "").trim().slice(0, 1000),
    coverEmoji: String(body.coverEmoji || (existing && existing.coverEmoji) || DEFAULT_COVER).slice(0, 8),
    tags: g.tags.length ? g.tags : (existing && existing.tags) || [],
    subject: ctx.meta.subject, shared: true, aigcDeclaredAt: new Date(),
    license: { source: (g.built.doc.license && g.built.doc.license.source) || (ctx.doc.license && ctx.doc.license.source) || "" }, policy: ctx.meta.policy, releaseVersion: version,
    ...(fork ? { remixOf: ctx.course.sourcePersona } : {}),
  };
  const persona = existing || new Persona({ price: 0 });
  Object.assign(persona, fields);
  await persona.save();
  const rel = await TutorRelease.create({
    persona: persona._id, course: ctx.course._id, owner: user._id, version, personaId: g.built.doc.id, name: g.name,
    doc: g.built.doc, text: g.built.text, checksum: g.built.checksum, sha256: sha256Hex(g.built.text), produceId: (g.built.doc.AIGC && g.built.doc.AIGC.ProduceID) || "",
    stages: g.built.doc.map.stages.length, note: String(body.note || "").trim().slice(0, 200),
  });
  persona.currentDoc = rel._id;
  await persona.save();
  if (version > 1) void notifyLearners(persona, rel, user); // 学习者收 TUTOR_DOC_UPDATED（docs/02 5.9 / 6.5）：不等、不影响发布成败
  return { status: 201, body: { ok: true, persona: publishView(persona, rel, { remixName }), warnings: g.built.warnings || [] } };
}

/** 作者发了 v(n+1) → 每个从这位老师开过课的学习者一条（作者自己那门不算；同人同版 24 小时一条；上限 / 并发在 tutorNotify） */
async function notifyLearners(persona, rel, author) {
  try {
    const courses = await TutorCourse.find({ sourcePersona: persona._id, owner: { $ne: author._id } }).select("_id owner").lean();
    const n = await notify.notifyMany("TUTOR_DOC_UPDATED", courses.map((c) => ({ userId: c.owner, payload: { personaId: String(persona._id), personaName: persona.name, version: rel.version, courseId: String(c._id), note: rel.note || "" } })), { actorId: author._id, dedupeOf: (pl) => ({ personaId: pl.personaId, version: pl.version }) });
    if (courses.length) console.log(`[tutor] ${persona.name} v${rel.version}：通知了 ${n}/${courses.length} 位学习者`);
  } catch (e) { console.error("[tutor] 新版通知失败:", (e && e.message) || e); }
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
  const p = await Persona.findOne({ kind: "tutor", course: courseId }).populate("remixOf", "_id name").lean();
  if (!p) return null;
  const rel = p.currentDoc ? await TutorRelease.findById(p.currentDoc).select("version sha256 checksum produceId publishedAt").lean() : null;
  return publishView(p, rel);
}

module.exports = { checkGates, publish, unpublish, publishState, publishView, TAGS_MAX, DEFAULT_COVER };
