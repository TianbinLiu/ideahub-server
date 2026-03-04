const Notification = require("../models/Notification");
const mongoose = require("mongoose");

async function createNotification({ userId, actorId, ideaId, type, payload = {} }) {
  // 确保 userId 和 actorId 都是有效的 ObjectId
  if (!userId) {
    console.error(`[Notification] Error: userId is required`);
    throw new Error("userId is required for notification");
  }

  // 自动转换为 ObjectId（如果是字符串）
  const userObjId = mongoose.Types.ObjectId.isValid(userId) ? userId : null;
  const actorObjId = actorId && mongoose.Types.ObjectId.isValid(actorId) ? actorId : null;

  console.log(`[Notification] Creating notification: userId=${userObjId}, actorId=${actorObjId}, type=${type}`);

  // 不给自己发通知
  if (userObjId && actorObjId && userObjId.toString() === actorObjId.toString()) {
    console.log(`[Notification] Skipped self-notification`);
    return null;
  }

  try {
    const notif = await Notification.create({
      userId: userObjId,
      actorId: actorObjId,
      ideaId,
      type,
      payload,
    });
    console.log(`[Notification] Created successfully: ${notif._id}`);
    return notif;
  } catch (err) {
    console.error(`[Notification] Error creating notification: ${err.message}`);
    throw err;
  }
}

module.exports = { createNotification };
