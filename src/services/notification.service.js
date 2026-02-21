const Notification = require("../models/Notification");

async function createNotification({ userId, actorId, ideaId, type, payload = {} }) {
  // 确保 userId 和 actorId 都是有效的 ObjectId 字符串
  const userIdStr = userId ? String(userId) : null;
  const actorIdStr = actorId ? String(actorId) : null;

  console.log(`[Notification] Creating notification: userId=${userIdStr}, actorId=${actorIdStr}, type=${type}`);

  // 不给自己发通知
  if (userIdStr && actorIdStr && userIdStr === actorIdStr) {
    console.log(`[Notification] Skipped self-notification`);
    return null;
  }

  if (!userIdStr) {
    console.error(`[Notification] Error: userId is required`);
    throw new Error("userId is required for notification");
  }

  try {
    const notif = await Notification.create({
      userId: userIdStr,
      actorId: actorIdStr,
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
