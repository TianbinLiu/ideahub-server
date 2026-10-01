"use strict";
/**
 * 教授认领（instructorClaim）的人工核实队列（tutor 仓 docs/02 9.4、docs/06 §4.1 / §4.2、docs/07「教授视角」；2026-09-29）。
 * ★ 与通用举报队列（GET /api/admin/branch/reports）是**同一张 Report 表、同一份处置正文**（reportResolve.service）：这里只是按理由切出一条单独的车道，
 *   多了「联系举报人要证据」这一步与两头的通知 —— 教授认领不能像刷屏那样批处理（Report.js 那条注释），得先核实身份再下架。
 * ★ 阶段**不新增 status 取值**（跨仓枚举）：new = pending 且没联系过；awaiting = pending 且联系过（等举报人补证据）；upheld = taken_down；rejected = dismissed。
 *   联系记录落在 Report.review（contactedAt / contactCount / log），status 一个字不动。
 * ★ 队列顺序是**先来先处理**（createdAt 升序）：核实是排队，不是刷新看最新；通用队列的「新的在前」在这里反而会让最早来的教授一直等。
 * ★ 通知一律 ADMIN_NOTICE 平台口径、不带 actorId（与 branchAdmin.notifyUser 同口径：审核员不该被摆到被骚扰的位置上）；举报人的 email 不回给管理端（branchAdminUsers U5）。
 * ★ 裁定成立 = 走 registry 下架（persona 只下架不删）+ 同一位老师上其余待处理举报一起收尾 + 通知作者与举报人；不成立 = dismiss + 只通知举报人。通知失败只记日志，裁定不回滚。
 */
const mongoose = require("mongoose");
const Report = require("../models/Report");
const Persona = require("../models/Persona");
const { resolveReportRecord, USER_FIELDS } = require("./reportResolve.service");
const { createNotification } = require("./notification.service");

const CLAIM = Object.freeze({ targetType: "persona", reason: "instructorClaim" });
const STAGES = ["new", "awaiting", "upheld", "rejected", "all"];
const MESSAGE_MAX = 500;
const PAGE_MAX = 50;

function stageOf(r) {
  if (!r) return "unknown";
  if (r.status === "taken_down") return "upheld";
  if (r.status === "dismissed") return "rejected";
  if ((r.status || "pending") !== "pending") return "closed"; // deleted 之类不该出现在这条车道上（persona 没有 delete），如实标出来
  return r.review && r.review.contactedAt ? "awaiting" : "new";
}
function stageFilter(stage) {
  switch (stage) {
    case "new": return { status: "pending", "review.contactedAt": null }; // null 同时命中「没这一格」（老数据）
    case "awaiting": return { status: "pending", "review.contactedAt": { $ne: null } };
    case "upheld": return { status: "taken_down" };
    case "rejected": return { status: "dismissed" };
    default: return {};
  }
}
const userView = (u) => (u && typeof u === "object" ? { _id: String(u._id), username: u.username || "", displayName: u.displayName || "" } : { _id: String(u || ""), username: "", displayName: "" });
function personaView(p) {
  if (!p) return { exists: false };
  return {
    exists: true, id: String(p._id), name: p.name || "", subject: p.subject || "", author: userView(p.author), shared: !!p.shared, takenDown: !!p.takenDown, takenDownReason: p.takenDownReason || "",
    version: Number(p.releaseVersion || 0), downloadCount: Number((p.stats && p.stats.downloadCount) || 0), ratingCount: Number((p.stats && p.stats.ratingCount) || 0), createdAt: p.createdAt, marketPath: `/tutor/market/${String(p._id)}`,
  };
}
function view(r, persona) {
  const rv = r.review || {};
  return {
    id: String(r._id), stage: stageOf(r), status: r.status || "pending", reason: r.reason, detail: r.detail || "", createdAt: r.createdAt,
    reporter: userView(r.reporter), handler: r.handler ? userView(r.handler) : null, handledAt: r.handledAt || null, handleNote: r.handleNote || "",
    review: { contactedAt: rv.contactedAt || null, contactCount: Number(rv.contactCount || 0), log: (rv.log || []).map((l) => ({ at: l.at, by: l.by ? String(l.by && l.by._id ? l.by._id : l.by) : null, action: l.action, note: l.note || "" })) },
    persona: persona || { exists: false },
  };
}
const PERSONA_FIELDS = "_id name subject author shared takenDown takenDownReason releaseVersion stats createdAt";
async function personasOf(ids) {
  const rows = ids.length ? await Persona.find({ _id: { $in: ids } }).select(PERSONA_FIELDS).populate("author", "_id username").lean() : [];
  return new Map(rows.map((p) => [String(p._id), personaView(p)]));
}
async function countsByStage() {
  const keys = ["new", "awaiting", "upheld", "rejected"];
  const ns = await Promise.all(keys.map((s) => Report.countDocuments({ ...CLAIM, ...stageFilter(s) })));
  return Object.fromEntries(keys.map((k, i) => [k, ns[i]]));
}

async function list({ stage = "new", page = 1, limit = 20 } = {}) {
  const st = STAGES.includes(String(stage)) ? String(stage) : "new";
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), PAGE_MAX);
  const filter = { ...CLAIM, ...stageFilter(st) };
  const sort = st === "new" || st === "awaiting" ? { createdAt: 1, _id: 1 } : { handledAt: -1, createdAt: -1 };
  const [rows, total, counts] = await Promise.all([
    Report.find(filter).sort(sort).skip((p - 1) * l).limit(l).populate("reporter", USER_FIELDS).populate("handler", USER_FIELDS).lean(),
    Report.countDocuments(filter),
    countsByStage(),
  ]);
  const personas = await personasOf([...new Set(rows.map((r) => String(r.targetId)))]);
  return { items: rows.map((r) => view(r, personas.get(String(r.targetId)))), total, page: p, limit: l, stage: st, counts };
}

async function loadClaim(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Report.findOne({ _id: id, ...CLAIM }).lean();
}
/** 平台口径的一条通知；失败只记日志（铁律八：局部），回 null */
async function notice(userId, payload) {
  try { return await createNotification({ userId, type: "ADMIN_NOTICE", payload }); }
  catch (e) { console.error("[tutor] 教授认领 通知失败:", (e && e.message) || e); return null; }
}

async function contact({ id, operator, message }) {
  const r = await loadClaim(id);
  if (!r) return { status: 404, body: { ok: false, message: "没有这条教授认领" } };
  if ((r.status || "pending") !== "pending") return { status: 409, body: { ok: false, code: "HANDLED", message: `这条已经处理过了（${stageOf(r)}）`, stage: stageOf(r) } };
  const text = String(message || "").trim();
  if (!text) return { status: 400, body: { ok: false, message: "要发给举报人的话不能为空" } };
  if (text.length > MESSAGE_MAX) return { status: 400, body: { ok: false, message: `最多 ${MESSAGE_MAX} 字（给了 ${text.length}）` } };
  const sent = await notice(r.reporter, { text, claimId: String(r._id), personaId: String(r.targetId) });
  const now = new Date();
  const updated = await Report.findByIdAndUpdate(r._id, { $set: { "review.contactedAt": now }, $inc: { "review.contactCount": 1 }, $push: { "review.log": { at: now, by: operator._id, action: "contact", note: text } } }, { returnDocument: "after" }).populate("reporter", USER_FIELDS).populate("handler", USER_FIELDS).lean();
  console.warn(`[tutor] 教授认领 联系举报人 claim=${id} admin=${operator._id} text=${text.slice(0, 60)}`);
  const personas = await personasOf([String(r.targetId)]);
  return { status: 200, body: { ok: true, notified: !!sent, claim: view(updated, personas.get(String(r.targetId))) } };
}

async function verdict({ id, operator, verdict: v, note }) {
  const r = await loadClaim(id);
  if (!r) return { status: 404, body: { ok: false, message: "没有这条教授认领" } };
  if ((r.status || "pending") !== "pending") return { status: 409, body: { ok: false, code: "HANDLED", message: `这条已经处理过了（${stageOf(r)}）`, stage: stageOf(r) } };
  if (v !== "upheld" && v !== "rejected") return { status: 400, body: { ok: false, message: "verdict 只能是 upheld（成立 → 下架）或 rejected（不成立 → 驳回）" } };
  const clean = String(note || "").trim().slice(0, 500);
  const persona = await Persona.findById(r.targetId).select("_id name author").lean();
  if (v === "upheld" && !persona) return { status: 409, body: { ok: false, code: "TARGET_GONE", message: "这位老师已不存在，没有可下架的；可按「不成立」驳回收尾" } };
  const action = v === "upheld" ? "takedown" : "dismiss";
  const out = await resolveReportRecord({ report: r, action, note: clean, operatorId: operator._id, reasonLabel: `教授认领经人工核实成立${clean ? `：${clean}` : ""}` });
  const name = persona ? persona.name : "";
  const tail = clean ? `备注：${clean}` : "";
  await notice(r.reporter, { text: v === "upheld" ? `你提交的教授认领已核实成立：老师人格「${name}」已下架。${tail}` : `你提交的教授认领未能核实成立，「${name}」未下架。${tail}`, claimId: String(r._id), personaId: String(r.targetId), verdict: v });
  if (v === "upheld" && persona) await notice(persona.author, { text: `你的老师人格「${name}」因教授认领经人工核实成立，已从市场下架。${tail}如有异议请联系客服。`, personaId: String(persona._id) });
  await Report.updateOne({ _id: r._id }, { $push: { "review.log": { at: new Date(), by: operator._id, action: v, note: clean } } });
  console.warn(`[tutor] 教授认领 裁定 claim=${id} verdict=${v} admin=${operator._id} alsoResolved=${out.alsoResolved}`);
  const personas = await personasOf([String(r.targetId)]);
  return { status: 200, body: { ok: true, verdict: v, applied: out.applied, alsoResolved: out.alsoResolved, takedown: out.takedownResult || null, claim: view({ ...out.updated, review: { ...(out.updated && out.updated.review), log: [...((out.updated && out.updated.review && out.updated.review.log) || []), { at: new Date(), by: operator._id, action: v, note: clean }] } }, personas.get(String(r.targetId))) } };
}

module.exports = { list, contact, verdict, stageOf, stageFilter, CLAIM, STAGES, MESSAGE_MAX };
