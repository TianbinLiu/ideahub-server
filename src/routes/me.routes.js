const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const User = require("../models/User");
const { listReceivedInterests } = require("../controllers/interest.controller");

router.get("/likes", requireAuth, async (req, res, next) => {
  try {
    const rows = await Like.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate({
        path: "idea",
        populate: { path: "author", select: "username role" },
      })
      .lean();

    const ideas = rows.map(r => r.idea).filter(Boolean);
    res.json({ ok: true, ideas });
  } catch (err) {
    next(err);
  }
});

router.get("/bookmarks", requireAuth, async (req, res, next) => {
  try {
    const rows = await Bookmark.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate({
        path: "idea",
        populate: { path: "author", select: "username role" },
      })
      .populate({
        path: "leaderboard",
        populate: { path: "author", select: "username role" },
      })
      .lean();

    const ideas = rows.filter(r => r.type === "idea" && r.idea).map(r => r.idea);
    const leaderboards = rows.filter(r => r.type === "leaderboard" && r.leaderboard).map(r => r.leaderboard);
    
    res.json({ ok: true, ideas, leaderboards });
  } catch (err) {
    next(err);
  }
});

router.get("/received-interests", requireAuth, listReceivedInterests);

// PUT /api/me/profile - Update user profile
router.put("/profile", requireAuth, async (req, res, next) => {
  try {
    const { displayName, bio, avatarUrl } = req.body;
    const userId = req.user._id;

    const updates = {};
    if (displayName !== undefined) updates.displayName = displayName.trim();
    if (bio !== undefined) updates.bio = bio.trim();
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl.trim();

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('username displayName bio avatarUrl role createdAt');

    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
