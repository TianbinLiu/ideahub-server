const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }, // 接收者
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // 触发者
    ideaId: { type: mongoose.Schema.Types.ObjectId, ref: "Idea" },   // 关联idea

    // ★ 分支视频（ideahub-app 的作品）的关联对象**必须单开一个字段**，不能复用 ideaId：
    //   ideaId 是 `ref: "Idea"`，populate 时会去 ideas 集合里找一个 BranchVideo 的 _id，
    //   永远找不到 → 出来是 null。表现是"通知列表能看，但点进去哪儿都去不了"，
    //   而且**一个错都不报**（populate 找不到就是 null，不是异常）。
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", index: true },

    type: {
      type: String,
      required: true,
      enum: [
        "LIKE", "COMMENT", "BOOKMARK", "INTEREST", "MENTION", "INVITE",
        "LIKE_COMMENT", "DISLIKE_COMMENT", "LIKE_POST",
        "MESSAGE_REQUEST_ACCEPTED", "MESSAGE_REQUEST_REJECTED",
        // 分支视频四类。与 ideas 那套刻意不共用类型名：两边的 deeplink 目标不同
        // （videoId vs ideaId），共用一个 "LIKE" 会让 app 分不清该往哪跳。
        "BRANCH_LIKE", "BRANCH_COMMENT", "BRANCH_COMMENT_REPLY", "BRANCH_COMMENT_LIKE",
        // 评论里 @ 到了你。★ 与 ideas 那套的 "MENTION" 刻意分开：同上，deeplink 目标不同
        // （videoId vs ideaId），而且 app 的消息页按类型白名单过滤，混用会让它跳错地方。
        "BRANCH_MENTION",
        // 平台通知（管理员手动发给某个用户的自由文本）。payload 形状：{ text }。
        // ★ **不带 actorId**（写入点在 branchAdmin.controller 的 notifyUser，传的就是
        //   undefined）：通知以**平台口径**发出，「具体是哪个管理员发的」不透给用户 ——
        //   与 takedown.by 同一条理由，审核员不该被摆到被骚扰的位置上；操作日志里有留痕。
        // ★★ 跨仓枚举（铁律九）：App 的 NotificationsPage 必须能渲染它；而且对**再未来的
        //   未知类型**必须降级显示（画成「系统通知 + 原样文本」之类），不许崩、不许吞 ——
        //   老包收到新类型是常态，不是异常（铁律七；契约见 docs/api-contract.md）。
        "ADMIN_NOTICE",
      ],
      index: true,
    },

    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1, createdAt: -1 });
// app 的未读红点是「按这四个 BRANCH_* 类型过滤 + readAt=null」查出来的，
// 三个键正好落在这条复合索引上，避免每次开 app 都全表扫一遍收件箱。
NotificationSchema.index({ userId: 1, type: 1, readAt: 1 });
// 通知去重（"同一个人对同一条作品的同一件事，24 小时内只提醒一次"）的查询形状。
// 去重规则本身只有一处实现，在 controllers/branchVideo.controller.js 的 notifyBranch；
// 这条索引只是让那次 exists() 不至于扫全收件箱。
NotificationSchema.index({ userId: 1, actorId: 1, type: 1, videoId: 1, createdAt: -1 });

// ★ videoId 由 services/notification.service.js 的 createNotification **显式传入**。
//   这里刻意不写「从 payload 里把 videoId 捞到顶层」的 pre hook：那种提升是没人
//   预期得到的间接层（写调用的人看不出这个字段是怎么落上去的），而公共签名多一个
//   可选参数的代价是零 —— 不传的调用方（ideas / messages / leaderboard）一个字都不用改。

module.exports = mongoose.model("Notification", NotificationSchema);
