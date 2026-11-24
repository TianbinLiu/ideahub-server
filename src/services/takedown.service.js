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
// ★ 2026-11-24 加的两类（对局里的 user / game-entry）**两格都空**，只有一句人话的 400：
//   它们本轮只做「受理 + 人工核实」，处置正文不在这一轮（深做后台不在本轮）。详见各自注册项的 ★。
//   ⚠ 注册项本身不能省：tests/takedownRegistry.spec.js 钉住「Report.TARGET_TYPES 里每一种都有处理器」，
//   少了的表现是管理员点下架得到一句"Unsupported target type"（认不出的类型），而不是"这类没有那种处置"。
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
  /**
   * 玩家本人（2026-11-24，工坊对局的举报 `user`）。
   * ★ 两格都空**不是漏写**：账号处置与内容处置是两条线（见 User.banned 头上那段 ★★）。
   *   「把这条举报标成 taken_down」在这一类上没有可对应的东西 —— 封人走
   *   POST /api/admin/branch/users/:id/ban（那条路不碰举报队列），删号是用户自己的权利。
   *   管理员对这类举报要做的只有驳回；想封人就去封人。这里如实 400，绝不假装办成了。
   */
  user: {
    noTakedown:
      "「用户」没有下架这种处置：封人走 POST /api/admin/branch/users/:id/ban（与内容处置分开，见 User.banned）；这条举报请用 action=dismiss 收尾。",
    noDelete: "举报不提供删号：删号由用户本人发起，或走 POST /api/admin/branch/users/:id/ban 封禁。",
  },
  /**
   * 对局回合投稿（2026-11-24，`game-entry`）。
   * ★ 本轮只做「受理 + 人工核实」：投稿内嵌在房间文档的 rounds[].entries[] 里（过期整份删），
   *   没有独立的隐藏位；而在本轮删一条投稿会打乱「全员已交片 / 已点赞 / 已投票」这些判定
   *   （allSubmitted / likesPending / 结算榜单都按参与人算），所以不下发 takedown / delete 两格。
   *   管理员用 action=dismiss 收尾；要动内容就整房处理（过期懒清理，见 GameRoom 文件头）。
   */
  "game-entry": {
    noTakedown:
      "回合投稿本轮没有可撤销的下架：它跟着房间文档走（没有独立隐藏位），删一条会打乱「全员已交片」等回合判定；请用 action=dismiss 收尾。",
    noDelete:
      "回合投稿本轮不提供硬删除：删一条会打乱「全员已交片」等回合判定（房间过期会整份清理）；请用 action=dismiss 收尾。",
  },
};

/**
 * 处置一个被举报的对象。
 * @param {"video"|"comment"|"danmaku"|"persona"|"user"|"game-entry"} targetType
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
