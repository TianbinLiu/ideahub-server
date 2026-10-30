// src/services/takedown.service.js
// 「下架 / 删除一个对象」的对外入口 —— 举报处理（controllers/report.controller.js）
// 唯一的落点。接口形状由那条线在 report.controller 的 loadTakedown() 里写死：
//
//     takedownTarget({ targetType, targetId, operatorId, reason, hard }) => Promise<{applied, targetType, targetId, removed}>
//     失败 throw。
//
// ★★ 2026-09-28 从 if-chain 改成**按 targetType 注册**的 registry（评审 graftedIdeas C、治理 P5）：加一种对象 = 加一个处理器，
//   不再往函数里塞分支；Report.TARGET_TYPES 里的每一种都必须在这里有处理器（tests/takedownRegistry.spec.js 钉住），
//   漏了的表现是管理员点「下架」得到 400「Unsupported target type」，而不是静默什么都没发生。
//   每个处理器分 takedown（可撤销、内容还在）与 delete（不可撤销）两格；**没有那一格就如实 400**，绝不替管理员把"下架"办成"删除"
//   （举报记录上写着 taken_down、内容其实没了 —— 事后申诉谁也说不清，铁律八）。
//
// ★★ 这个文件里**没有一行作品线的清理逻辑**，全部转调 branchVideo.controller 导出的那三个函数
//   （applyTakedown / purgeVideo / purgeComments）。硬删一条作品要连带清六张表，
//   在这里抄一份的结果一定是漏掉其中一两样 —— 而漏了不报错，库里只是多出一批
//   谁也查不到、也再删不掉的行（铁律六）。
//
// ★ 依赖方向确实是"service → controller"，反过来的。刻意为之：那几个清理函数
//   紧挨着它们要清的模型与那一长串"为什么要清它"的注释，搬过来只会让注释与实现分家。
//   反向依赖不会成环：branchVideo.controller **不** require 这个文件。
//
// ★ 人格（persona）只有 takedown 没有 delete：人格是作者的资产（别人可能已下载 / 已购），下架 = shared:false + takenDown:true 就足够把它从市场与他人视野里摘掉；
//   要删由作者自己 DELETE /api/personas/:id。作者看得见 takenDownReason、看不见 takenDownBy（docs/02 6.6）。
const mongoose = require("mongoose");
const BranchVideo = require("../models/BranchVideo");
const BranchComment = require("../models/BranchComment");
const BranchDanmaku = require("../models/BranchDanmaku");
const Persona = require("../models/Persona");
const { applyTakedown, purgeVideo, purgeComments } = require("../controllers/branchVideo.controller");
const { badRequest, notFound } = require("../utils/http");

const done = (applied, targetType, targetId, removed = 0) => ({ applied, targetType, targetId: String(targetId), removed });

/**
 * 处理器注册表：targetType → { takedown?, delete? }。缺哪一格就是「这种对象没有那种处置」，takedownTarget 会整句 400。
 * @type {Record<string, { takedown?: Function, delete?: Function, noTakedown?: string, noDelete?: string }>}
 */
const HANDLERS = {
  video: {
    async takedown({ targetId, operatorId, reason }) {
      const doc = await applyTakedown(targetId, { by: operatorId, reason, on: true });
      if (!doc) notFound("Video not found");
      return done("takedown", "video", targetId);
    },
    async delete({ targetId }) {
      // 作品得先确认存在：purgeVideo 对一个不存在的 id 会安安静静地删 0 行，
      // 举报那边就会把状态标成 deleted 而其实什么都没发生。
      const exists = await BranchVideo.exists({ _id: targetId });
      if (!exists) notFound("Video not found");
      const { removed } = await purgeVideo(targetId);
      return done("delete", "video", targetId, removed);
    },
  },
  comment: {
    noTakedown: "评论没有可撤销的下架，只能删除：请改用 action=delete。",
    async delete({ targetId }) {
      // 删一条评论要连带清它的回复、点赞行、指向它的通知，并回写 commentCount —— 四样。
      // 这些全在 purgeComments 里，这里只负责把它需要的 videoId 找出来。
      const comment = await BranchComment.findById(targetId).select("_id video").lean();
      if (!comment) notFound("Comment not found");
      const { removed } = await purgeComments(comment.video, comment._id);
      return done("delete", "comment", targetId, removed);
    },
  },
  danmaku: {
    noTakedown: "弹幕没有可撤销的下架，只能删除：请改用 action=delete。",
    async delete({ targetId }) {
      // 弹幕没有级联：它不发通知（发了就等于把匿名的弹幕去匿名化），也没有点赞表。
      const r = await BranchDanmaku.deleteOne({ _id: targetId });
      if (!r.deletedCount) notFound("Danmaku not found");
      return done("delete", "danmaku", targetId, 1);
    },
  },
  persona: {
    noDelete: "人格没有硬删除：下架（action=takedown）就已把它从市场与他人视野里摘掉；要删由作者自己删。",
    async takedown({ targetId, operatorId, reason }) {
      const r = await Persona.updateOne({ _id: targetId }, { $set: { takenDown: true, shared: false, takenDownAt: new Date(), takenDownReason: String(reason || "").slice(0, 500), takenDownBy: operatorId } });
      if (!r.matchedCount) notFound("Persona not found");
      return done("takedown", "persona", targetId);
    },
  },
};

/**
 * 处置一个被举报的对象。
 * @param {"video"|"comment"|"danmaku"|"persona"} targetType
 * @param {string} targetId
 * @param {string} operatorId 处理这条举报的管理员
 * @param {string} reason     给作者看的原因（作品与人格的下架用得上：会原样显示给作者）
 * @param {boolean} hard      false = 下架（可撤销，内容还在）；true = 硬删除（不可撤销）
 */
async function takedownTarget({ targetType, targetId, operatorId, reason = "", hard = false } = {}) {
  if (!mongoose.isValidObjectId(targetId)) badRequest("Invalid target id");
  const h = HANDLERS[targetType];
  if (!h) badRequest(`Unsupported target type: ${String(targetType).slice(0, 20)}`);
  const fn = hard ? h.delete : h.takedown;
  if (!fn) badRequest(hard ? h.noDelete || `${targetType} 没有硬删除` : h.noTakedown || `${targetType} 没有可撤销的下架`);
  return fn({ targetId, operatorId, reason });
}

module.exports = { takedownTarget, TAKEDOWN_TARGETS: Object.keys(HANDLERS), HANDLERS };
