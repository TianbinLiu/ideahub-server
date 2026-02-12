const Notification = require("../models/Notification");

async function createNotification({ userId, actorId, ideaId, type, payload = {} }) {
  // 不给自己发通知
  if (actorId && String(userId) === String(actorId)) return null;

  return Notification.create({
    userId,
    actorId,
    ideaId,
    type,
    payload,
  });
}

module.exports = { createNotification };
