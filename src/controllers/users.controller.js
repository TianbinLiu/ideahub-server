const User = require("../models/User");

/**
 * GET /api/users/search?q=username&limit=8
 * Search for users by username (for @mention suggestions)
 */
async function searchUsers(req, res, next) {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10), 1), 20);
    
    if (!q || q.length < 1) {
      return res.json({ ok: true, users: [] });
    }

    // Search by username pattern
    const re = new RegExp(`^${q.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`, "i");
    const users = await User.find({ username: re })
      .select("_id username")
      .limit(limit)
      .lean();

    res.json({ ok: true, users });
  } catch (err) {
    next(err);
  }
}

module.exports = { searchUsers };
