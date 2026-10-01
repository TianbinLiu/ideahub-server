// src/services/tutorLedger.service.js
// 老师人格的用量账本（tutor 仓 docs/10）：订阅 core/ai/client.js 的 onUsage，每一发落一行 TutorUsage；
// GET /api/tutor/usage-ledger 汇总（core/measure 的 summarizeLedger 是纯函数，与 tutor 仓同一份）。
// ★ 账本是旁路：写失败只打日志，绝不影响那一发教学 / 生成（铁律八的「局部」：失败要响，但响在日志里，不响在用户的课上）。
// ★ 记录里的 user / course 从 meta 里取（调用点在 meta 里放 courseId / userId），正文一个字不进来。
const mongoose = require("mongoose");
const TutorUsage = require("../models/TutorUsage");
const { onUsage } = require("../tutor/core/ai/client");
const { summarizeLedger } = require("../tutor/core/measure/index");

let attached = false;
/** 挂一次订阅（tutor.routes 装载时调用；重复调用是空操作） */
function attachLedger() {
  if (attached) return;
  attached = true;
  onUsage((rec) => {
    const { userId, courseId, ...meta } = rec.meta || {};
    const row = { ...rec, at: new Date(rec.at), meta, user: mongoose.isValidObjectId(userId) ? userId : undefined, course: mongoose.isValidObjectId(courseId) ? courseId : undefined };
    TutorUsage.create(row).catch((e) => console.error("[tutor] 用量账本写不进:", (e && e.message) || e));
  });
}

/** 某个用户的账本（since = ISO 时间；最多 2000 行原始记录，汇总按全部算） */
async function readLedger({ user, since, limit = 2000 } = {}) {
  const q = { user };
  if (since) { const t = new Date(since); if (!Number.isNaN(t.getTime())) q.at = { $gte: t }; }
  const rows = await TutorUsage.find(q).sort({ at: 1 }).lean();
  const recs = rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  return { count: recs.length, summary: summarizeLedger(recs), records: recs.slice(-limit) };
}

module.exports = { attachLedger, readLedger };
