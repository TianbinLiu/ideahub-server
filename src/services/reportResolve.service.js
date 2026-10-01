"use strict";
/**
 * 处置一条举报的**正文**（下架 / 删除 / 驳回 → 状态 + 处理人 + 级联收尾），从 report.controller.resolveReport 抽出来（2026-09-29）：
 * 管理端 PATCH /api/admin/branch/reports/:id 与老师人格「教授认领」的人工核实队列（那条线自己的服务里的裁定）都走这一份 —— 「处置举报」的规则只有一处（铁律六）。
 * ★ 调用方负责：id 合法、举报存在、还是 pending（409）、下架服务在不在（那个 501 探针是 controller 的历史包袱，留在那边）。
 * ★ takedown / delete 成功后同一对象上其余待处理举报一起收尾；dismiss 不级联（不同人举报的可能是不同理由）。下架本身失败**不改状态**，异常原样上抛。
 * ★ 动作 → 状态只查 Report.ACTION_STATUS 那一张表，这里不写 if。
 */
const Report = require("../models/Report");

const USER_FIELDS = "_id username displayName avatarUrl";

/**
 * @param {{ report: object, action: "takedown"|"delete"|"dismiss", note?: string, operatorId: any, reasonLabel?: string }} p
 *   reasonLabel = 给作者看的那句人话（默认 Report.REASON_LABELS[reason]，表里没有退回 key）
 * @returns {Promise<{ updated: object, takedownResult: any, alsoResolved: number, applied: boolean }>}
 */
async function resolveReportRecord({ report, action, note = "", operatorId, reasonLabel }) {
  if (!Report.ACTION_STATUS[action]) throw new Error(`unknown report action: ${action}`);
  const touchesContent = action === "takedown" || action === "delete";
  let takedownResult = null;
  if (touchesContent) {
    const { takedownTarget } = require("./takedown.service"); // 懒 require：takedown.service 那头反过来 require 控制器（report.controller.loadTakedown 头上说过）
    takedownResult = await takedownTarget({
      targetType: report.targetType,
      targetId: report.targetId,
      operatorId,
      reason: reasonLabel || Report.REASON_LABELS[report.reason] || report.reason,
      hard: action === "delete",
    });
  }
  const patch = { status: Report.ACTION_STATUS[action], handler: operatorId, handledAt: new Date(), handleNote: typeof note === "string" ? note : "" };
  const updated = await Report.findByIdAndUpdate(report._id, { $set: patch }, { returnDocument: "after" }).populate("reporter", USER_FIELDS).populate("handler", USER_FIELDS).lean();
  let alsoResolved = 0;
  if (touchesContent) {
    const r = await Report.updateMany({ targetType: report.targetType, targetId: report.targetId, status: "pending", _id: { $ne: report._id } }, { $set: patch });
    alsoResolved = Number((r && r.modifiedCount) || 0);
  }
  return { updated, takedownResult, alsoResolved, applied: touchesContent };
}

module.exports = { resolveReportRecord, USER_FIELDS };
