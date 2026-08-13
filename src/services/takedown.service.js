// src/services/takedown.service.js
// 「下架 / 删除一个对象」的对外入口 —— 举报处理（controllers/report.controller.js）
// 唯一的落点。接口形状由那条线在 report.controller 的 loadTakedown() 里写死：
//
//     takedownTarget({ targetType, targetId, operatorId, reason, hard }) => Promise<{removed?...}>
//     失败 throw。
//
// ★★ 这个文件里**没有一行清理逻辑**，全部转调 branchVideo.controller 导出的那三个函数
//   （applyTakedown / purgeVideo / purgeComments）。硬删一条作品要连带清六张表，
//   在这里抄一份的结果一定是漏掉其中一两样 —— 而漏了不报错，库里只是多出一批
//   谁也查不到、也再删不掉的行（铁律六）。
//
// ★ 依赖方向确实是"service → controller"，反过来的。刻意为之：那几个清理函数
//   紧挨着它们要清的模型与那一长串"为什么要清它"的注释，搬过来只会让注释与实现分家。
//   反向依赖不会成环：branchVideo.controller **不** require 这个文件。
const mongoose = require("mongoose");
const BranchVideo = require("../models/BranchVideo");
const BranchComment = require("../models/BranchComment");
const BranchDanmaku = require("../models/BranchDanmaku");
const { applyTakedown, purgeVideo, purgeComments } = require("../controllers/branchVideo.controller");
const { badRequest, notFound } = require("../utils/http");

/**
 * 处置一个被举报的对象。
 *
 * @param {"video"|"comment"|"danmaku"} targetType
 * @param {string} targetId
 * @param {string} operatorId 处理这条举报的管理员
 * @param {string} reason     给作者看的原因（只有视频下架用得上：它会显示在作者的作品上）
 * @param {boolean} hard      false = 下架（可撤销，内容还在）；true = 硬删除（不可撤销）
 * @returns {Promise<{applied: string, targetType: string, targetId: string, removed: number}>}
 *
 * ★★ 「评论/弹幕没有可撤销的下架」这件事**如实抛错，不静默降级成删除**。
 *   悄悄替管理员把"下架"办成"删除"是这一整块里最坏的一种失败：举报记录上写着
 *   `taken_down`（可撤销、内容还在），而内容其实已经没了 —— 事后申诉时谁也说不清
 *   到底发生过什么，而且一个错都没报（铁律八；Report.js 里也专门写了
 *   "两者是两件事，状态必须分得开"）。
 *   要给评论/弹幕做真正的下架，得给那两张表也加隐藏位并改它们的列表查询，
 *   那是另一件事，不能靠这里一个 if 蒙混过去。
 */
async function takedownTarget({ targetType, targetId, operatorId, reason = "", hard = false } = {}) {
  if (!mongoose.isValidObjectId(targetId)) badRequest("Invalid target id");

  if (targetType === "video") {
    if (hard) {
      // 作品得先确认存在：purgeVideo 对一个不存在的 id 会安安静静地删 0 行，
      // 举报那边就会把状态标成 deleted 而其实什么都没发生。
      const exists = await BranchVideo.exists({ _id: targetId });
      if (!exists) notFound("Video not found");
      const { removed } = await purgeVideo(targetId);
      return { applied: "delete", targetType, targetId: String(targetId), removed };
    }
    const doc = await applyTakedown(targetId, { by: operatorId, reason, on: true });
    if (!doc) notFound("Video not found");
    return { applied: "takedown", targetType, targetId: String(targetId), removed: 0 };
  }

  if (targetType === "comment") {
    if (!hard) {
      badRequest("评论没有可撤销的下架，只能删除：请改用 action=delete。");
    }
    // 删一条评论要连带清它的回复、点赞行、指向它的通知，并回写 commentCount —— 四样。
    // 这些全在 purgeComments 里，这里只负责把它需要的 videoId 找出来。
    const comment = await BranchComment.findById(targetId).select("_id video").lean();
    if (!comment) notFound("Comment not found");
    const { removed } = await purgeComments(comment.video, comment._id);
    return { applied: "delete", targetType, targetId: String(targetId), removed };
  }

  if (targetType === "danmaku") {
    if (!hard) {
      badRequest("弹幕没有可撤销的下架，只能删除：请改用 action=delete。");
    }
    // 弹幕没有级联：它不发通知（发了就等于把匿名的弹幕去匿名化），也没有点赞表。
    const r = await BranchDanmaku.deleteOne({ _id: targetId });
    if (!r.deletedCount) notFound("Danmaku not found");
    return { applied: "delete", targetType, targetId: String(targetId), removed: 1 };
  }

  badRequest(`Unsupported target type: ${String(targetType).slice(0, 20)}`);
}

module.exports = { takedownTarget };
