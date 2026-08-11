const Notification = require("../models/Notification");
const MessageRequest = require("../models/MessageRequest");
const DirectMessage = require("../models/DirectMessage");

/**
 * 类型过滤的唯一解析处："A,B,C" → ["A","B","C"]；没给（或全是空白）→ null = 不过滤。
 * ★ 列表与「全部已读」必须用同一份口径：两边形状对不上的话，用户在 app 里看到的是
 *   四类 BRANCH_* 通知，点「全部已读」却按另一套范围去标 —— 而两个请求都是 200。
 */
function parseTypeFilter(raw) {
  if (typeof raw !== "string") return null;
  const types = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return types.length ? types : null;
}

async function listMyNotifications(req, res, next) {
  try {
    const userId = req.user._id;

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);

    const filter = { userId };
    if (req.query.unread === "1") filter.readAt = null;

    // Support type filtering
    const types = parseTypeFilter(req.query.type);
    if (types) filter.type = { $in: types };

    console.log(`[Notifications] Fetching for userId=${userId}, filter=${JSON.stringify(filter)}`);

    const [items, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // ★ 必须带上 displayName / avatarUrl：通知列表每一行都是「头像 + 谁做了什么」。
        //   只 populate username 的话，改过昵称的人在通知里显示的是注册名，头像退回字母底
        //   —— 与他在首页/评论区的样子对不上，用户会以为是另一个人。
        .populate("actorId", "username displayName avatarUrl role")
        .populate("ideaId", "title visibility")
        // 分支视频通知的 deeplink 目标。ideaId 装不下它（ref 不同，populate 出来是 null），
        // 所以模型上单开了 videoId，见 models/Notification.js
        .populate("videoId", "title cover visibility")
        .lean(),
      Notification.countDocuments(filter),
    ]);

    console.log(`[Notifications] Found ${items.length} items, total=${total}`);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function getUnreadCount(req, res, next) {
  try {
    const userId = req.user._id;
    console.log(`[getUnreadCount] Checking unread for userId=${userId}`);
    
    // Count unread notifications
    const notificationCount = await Notification.countDocuments({ userId, readAt: null });
    
    // Count unread message requests (pending and not viewed)
    const messageRequestCount = await MessageRequest.countDocuments({
      toUserId: userId,
      status: "pending",
      viewedAt: null
    });

    const directMessageCount = await DirectMessage.countDocuments({
      toUserId: userId,
      readAt: null,
      deletedFor: { $ne: userId },
    });
    
    const totalCount = notificationCount + messageRequestCount + directMessageCount;
    console.log(`[getUnreadCount] Found ${notificationCount} unread notifications + ${messageRequestCount} unread message requests + ${directMessageCount} unread direct messages = ${totalCount} total`);
    res.json({ ok: true, count: totalCount });
  } catch (err) {
    next(err);
  }
}

async function markOneRead(req, res, next) {
  try {
    const userId = req.user._id;
    const { id } = req.params;

    const item = await Notification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: new Date() } },
      { new: true }
    ).lean();

    res.json({ ok: true, item });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/notifications/read-all —— 可选 `type`（逗号分隔，与列表端点同一形状）。
 *
 * ★★ 为什么这个过滤器非有不可：一个收件箱里装着两条产品线的通知。
 *   ideahub-app 的「消息」页**只显示**四类 BRANCH_*，官网显示其余那些。
 *   不带过滤地 updateMany 一把梭，用户在 app 里点一下「全部已读」，
 *   就把官网上那些他**从来没看见过**的 MENTION / INVITE / MESSAGE_REQUEST_*
 *   一起标成已读了 —— 它们不会消失，只是再也不会提醒他，而且全程 200，没有任何痕迹。
 *   "只标掉我正在看的那些"是调用方才知道的事，所以由调用方传范围。
 *
 * ⚠ 不传 type 时行为与以前**一模一样**（标掉全部未读）：官网那个客户端不传，
 *   一旦这里改成"默认只标某几类"，官网的「全部已读」就静默失效了。
 * body 与 query 都收：客户端的 POST 有的带 body 有的只拼 query，
 * 挑一种支持等于让另一种静默无效（点了没反应，红点还在）。
 */
async function markAllRead(req, res, next) {
  try {
    const userId = req.user._id;
    const filter = { userId, readAt: null };
    const types = parseTypeFilter(req.body?.type ?? req.query?.type);
    if (types) filter.type = { $in: types };

    const result = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    res.json({ ok: true, updated: Number(result?.modifiedCount || 0) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listMyNotifications,
  getUnreadCount,
  markOneRead,
  markAllRead,
};
