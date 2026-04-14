const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const User = require("../models/User");
const { listReceivedInterests } = require("../controllers/interest.controller");
const {
  getMyComponents,
  updateMyComponents,
  uploadLive2dBundle,
  uploadMyLive2dBundle,
} = require("../controllers/components.controller");
const { listBlockedUserIds, toIdString } = require("../utils/blocking");

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

    const blockedUserIds = await listBlockedUserIds(req.user._id);
    const ideas = rows
      .map(r => r.idea)
      .filter((idea) => idea && !blockedUserIds.has(toIdString(idea.author)));
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

    const blockedUserIds = await listBlockedUserIds(req.user._id);

    const ideas = rows
      .filter(r => r.type === "idea" && r.idea)
      .map(r => r.idea)
      .filter((idea) => !blockedUserIds.has(toIdString(idea.author)));
    const leaderboards = rows
      .filter(r => r.type === "leaderboard" && r.leaderboard)
      .map(r => r.leaderboard)
      .filter((leaderboard) => !blockedUserIds.has(toIdString(leaderboard.author)));
    
    res.json({ ok: true, ideas, leaderboards });
  } catch (err) {
    next(err);
  }
});

router.get("/received-interests", requireAuth, listReceivedInterests);
router.get("/components", requireAuth, getMyComponents);
router.put("/components", requireAuth, updateMyComponents);
router.post("/components/live2d/upload", requireAuth, uploadLive2dBundle.single("bundle"), uploadMyLive2dBundle);

// POST /api/me/avatar - Upload avatar image
router.post("/avatar", requireAuth, upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // 上传到 Cloudinary
    const { uploadToCloudinary } = require('../middleware/upload');
    const avatarUrl = await uploadToCloudinary(
      req.file.buffer,
      'avatars',
      req.user._id.toString()
    );

    // 更新用户头像
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { avatarUrl } },
      { new: true, runValidators: true }
    ).select('username displayName bio avatarUrl role createdAt');

    res.json({ ok: true, user, avatarUrl });
  } catch (err) {
    next(err);
  }
});

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
