const Notification = require("../models/Notification");

async function listMyNotifications(req, res, next) {
  try {
    const userId = req.user._id;

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);

    const filter = { userId };
    if (req.query.unread === "1") filter.readAt = null;

    const [items, total] = await Promise.all([
      Notification.find(filter)
        .select("_id type readAt createdAt actorId ideaId payload")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("actorId", "username role")
        .populate("ideaId", "title visibility")
        .lean(),
      Notification.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function getUnreadCount(req, res, next) {
  try {
    const userId = req.user._id;
    const count = await Notification.countDocuments({ userId, readAt: null });
    res.json({ ok: true, count });
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

async function markAllRead(req, res, next) {
  try {
    const userId = req.user._id;
    await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
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
