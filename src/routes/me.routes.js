const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
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
      .lean();

    const ideas = rows.map(r => r.idea).filter(Boolean);
    res.json({ ok: true, ideas });
  } catch (err) {
    next(err);
  }
});

router.get("/received-interests", requireAuth, listReceivedInterests);


module.exports = router;
