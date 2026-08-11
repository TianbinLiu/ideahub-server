const Notification = require("../models/Notification");
const mongoose = require("mongoose");

/**
 * 全站唯一的通知入口。
 *
 * ★ 关联对象有**两个**字段，不是一个：
 *   - ideaId  → ref:"Idea"，ideas 产品线用
 *   - videoId → ref:"BranchVideo"，分支视频（ideahub-app 的作品）用
 *   两者不能互相顶替：把 BranchVideo 的 _id 塞进 ideaId，populate 会去 ideas 集合里
 *   找一个永远不存在的文档 → 出来是 null。表现是"通知列表能看，但点进去哪儿都去不了"，
 *   而且**一个错都不报**（populate 找不到就是 null，不是异常）。
 *   两个都不传是合法的（ideas 的邀请、消息请求、榜单通知本来就没有关联对象）。
 */
async function createNotification({ userId, actorId, ideaId, videoId, type, payload = {} }) {
  // 确保 userId 和 actorId 都是有效的 ObjectId
  if (!userId) {
    throw new Error("userId is required for notification");
  }

  // 自动转换为 ObjectId（如果是字符串）
  const userObjId = mongoose.Types.ObjectId.isValid(userId) ? userId : null;
  const actorObjId = actorId && mongoose.Types.ObjectId.isValid(actorId) ? actorId : null;

  // 不给自己发通知
  if (userObjId && actorObjId && userObjId.toString() === actorObjId.toString()) {
    return null;
  }

  try {
    const notif = await Notification.create({
      userId: userObjId,
      actorId: actorObjId,
      ideaId,
      videoId,
      type,
      payload,
    });
    return notif;
  } catch (err) {
    console.error(`[Notification] Error creating notification (${type}):`, err.message);
    throw err;
  }
}

module.exports = { createNotification };
