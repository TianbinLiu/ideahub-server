"use strict";
/**
 * 老师人格的四类通知（tutor 仓 docs/02 §9.6 / 4.9 / 5.9；契约「通知」一节）：
 *   TUTOR_RATING / TUTOR_COMMENT → 作者；TUTOR_REVIEW_DUE / TUTOR_DOC_UPDATED → 学习者。
 * ★ 唯一入口 notifyTutor：拉黑双向判（与 branchVideo.controller 的 notifyBranch 同一条理由：漏一条路径「这个人到不了我这儿」就是假的）、
 *   24 小时「同人同事」去重（键 = userId + actorId + type + dedupe 里那几格；branch 那套按 videoId 去重的实现在 branchVideo.controller.alreadyNotified，
 *   键不同、窗口同为 24 小时）、失败只记日志绝不抛 —— 通知不影响主流程（铁律八：响、且局部）。
 * ★ deeplink 一律在 payload 里（personaId → /tutor/market/:id、courseId → /tutor/courses/:id 或 /tutor/run/:id）：Notification 不再加顶层字段 ——
 *   加字段就要同时改 App 的映射，「服务端发了、App 静默丢掉」正是那张白名单要防的事故（Notification.js 里 BRANCH_REVISED 那段）。
 * ⚠ 老 App 的 BRANCH_NOTIFICATION_TYPES 是请求层白名单，这四类它压根不查：对 App 用户是「收不到」，不是降级显示（契约写明，不许说成降级）。
 */
const Notification = require("../models/Notification");
const { createNotification } = require("./notification.service");
const { hasAnyBlockBetween } = require("../utils/blocking");

const TUTOR_NOTIFICATION_TYPES = ["TUTOR_RATING", "TUTOR_COMMENT", "TUTOR_REVIEW_DUE", "TUTOR_DOC_UPDATED"];
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 扇出上限与并发（TUTOR_DOC_UPDATED 给全部学习者）：与 BRANCH_REVISED 同口径 —— 超了只发前 500 并留痕 */
const FANOUT_MAX = 500;
const FANOUT_CONCURRENCY = 8;

/** 窗口内已经发过同一件事？dedupe = payload 里参与去重的那几格（null = 不去重，每一条都是新的话） */
async function alreadySent({ userId, actorId, type, dedupe }) {
  if (!dedupe) return false;
  const q = { userId, type, createdAt: { $gte: new Date(Date.now() - DEDUP_WINDOW_MS) } };
  if (actorId) q.actorId = actorId;
  for (const [k, v] of Object.entries(dedupe)) q[`payload.${k}`] = v;
  return !!(await Notification.exists(q));
}

/**
 * 发一条。回 Notification 或 null（自己给自己 / 拉黑 / 窗口内重复 / 失败都是 null）。
 * @param {"TUTOR_RATING"|"TUTOR_COMMENT"|"TUTOR_REVIEW_DUE"|"TUTOR_DOC_UPDATED"} type
 */
async function notifyTutor(type, { userId, actorId = null, payload = {}, dedupe = null }) {
  if (!TUTOR_NOTIFICATION_TYPES.includes(type)) throw new Error(`不是老师人格的通知类型：${type}`);
  try {
    if (!userId) return null;
    if (actorId && String(actorId) === String(userId)) return null; // createNotification 也会拦，这里先拦省一次查库
    if (actorId && (await hasAnyBlockBetween(actorId, userId))) return null;
    if (await alreadySent({ userId, actorId, type, dedupe })) return null;
    return await createNotification({ userId, actorId: actorId || undefined, type, payload });
  } catch (e) {
    console.error(`[tutor] 通知 ${type} 失败:`, (e && e.message) || e);
    return null;
  }
}

/**
 * 扇出：recipients = [{ userId, payload }]；dedupeOf(payload) 给每一条的去重键（null = 不去重）。
 * 上限 FANOUT_MAX（超了只发前 500 并 warn 留痕）、并发 FANOUT_CONCURRENCY。回实际发出的条数。
 */
async function notifyMany(type, recipients, { actorId = null, dedupeOf = null } = {}) {
  const list = Array.isArray(recipients) ? recipients : [];
  if (list.length > FANOUT_MAX) console.warn(`[tutor] ${type} 扇出 ${list.length} 人，超过上限 ${FANOUT_MAX}，只发前 ${FANOUT_MAX} 个`);
  const todo = list.slice(0, FANOUT_MAX);
  let sent = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      const n = await notifyTutor(type, { userId: r.userId, actorId, payload: r.payload, dedupe: dedupeOf ? dedupeOf(r.payload) : null });
      if (n) sent++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, todo.length) }, worker));
  return sent;
}

/** 评论钩子（persona.routes 的 onCreated）：老师人格下有人留言 → 作者收 TUTOR_COMMENT；别的人格（陪聊）不管 */
async function onPersonaComment({ target, comment }) {
  if (!target || target.kind !== "tutor" || !comment) return null;
  const actorId = comment.author && typeof comment.author === "object" ? comment.author._id : comment.author;
  return notifyTutor("TUTOR_COMMENT", {
    userId: target.author, actorId,
    payload: { personaId: String(target._id), personaName: target.name || "", commentId: String(comment._id), preview: String(comment.content || "").slice(0, 120), parentId: comment.parentId ? String(comment.parentId) : null },
    dedupe: { personaId: String(target._id) }, // docs/02 9.6：同人同事 24 小时一条
  });
}

module.exports = { notifyTutor, notifyMany, alreadySent, onPersonaComment, TUTOR_NOTIFICATION_TYPES, DEDUP_WINDOW_MS, FANOUT_MAX, FANOUT_CONCURRENCY };
