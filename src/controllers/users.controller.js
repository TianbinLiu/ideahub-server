const User = require("../models/User");
const Follow = require("../models/Follow");
const Bookmark = require("../models/Bookmark");
const TagLeaderboard = require("../models/TagLeaderboard");
const LeaderboardPost = require("../models/LeaderboardPost");
const AppError = require("../utils/AppError");

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

/**
 * GET /api/users/:id
 * Get public user profile
 */
async function getUserProfile(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();

    const user = await User.findById(id).select('username displayName bio avatarUrl role createdAt');
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    // Count followers and following
    const followerCount = await Follow.countDocuments({ following: id });
    const followingCount = await Follow.countDocuments({ follower: id });

    // Check if current user follows this user
    let isFollowing = false;
    if (currentUserId && currentUserId !== id) {
      const follow = await Follow.findOne({ follower: currentUserId, following: id });
      isFollowing = !!follow;
    }

    res.json({
      ok: true,
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt,
        followerCount,
        followingCount,
        isFollowing,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/follow
 * Toggle follow/unfollow
 */
async function toggleFollow(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user._id.toString();

    if (currentUserId === id) {
      throw new AppError('Cannot follow yourself', 400, 'CANNOT_FOLLOW_SELF');
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const existing = await Follow.findOne({ follower: currentUserId, following: id });

    if (existing) {
      // Unfollow
      await Follow.deleteOne({ _id: existing._id });
      return res.json({ ok: true, following: false });
    } else {
      // Follow
      await Follow.create({ follower: currentUserId, following: id });
      return res.json({ ok: true, following: true });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/followers
 * Get user's followers
 */
async function getFollowers(req, res, next) {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const followers = await Follow.find({ following: id })
      .populate('follower', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Follow.countDocuments({ following: id });

    res.json({
      ok: true,
      followers: followers.map(f => f.follower),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/following
 * Get users that this user follows
 */
async function getFollowing(req, res, next) {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const following = await Follow.find({ follower: id })
      .populate('following', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Follow.countDocuments({ follower: id });

    res.json({
      ok: true,
      following: following.map(f => f.following),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/bookmarks
 * Get user's public bookmarks (ideas and leaderboards)
 */
async function getUserBookmarks(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();

    // Only show bookmarks if viewing own profile or if user is admin
    const isOwnProfile = currentUserId === id;
    const isAdmin = req.user?.role === 'admin';

    if (!isOwnProfile && !isAdmin) {
      return res.json({
        ok: true,
        ideas: [],
        leaderboards: [],
      });
    }

    const bookmarks = await Bookmark.find({ user: id })
      .populate('idea', 'title summary tags createdAt author')
      .populate('leaderboard', 'tags computedAt')
      .sort({ createdAt: -1 });

    const ideas = bookmarks
      .filter(b => b.type === 'idea' && b.idea)
      .map(b => b.idea);

    const leaderboards = bookmarks
      .filter(b => b.type === 'leaderboard' && b.leaderboard)
      .map(b => b.leaderboard);

    res.json({ ok: true, ideas, leaderboards });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/leaderboards
 * Get leaderboards created by user
 */
async function getUserLeaderboards(req, res, next) {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);

    const [items, total] = await Promise.all([
      TagLeaderboard.find({ author: id })
        .sort({ computedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id tags tagsKey computedAt entries")
        .lean(),
      TagLeaderboard.countDocuments({ author: id }),
    ]);

    const tagsKeys = items.map((b) => b.tagsKey).filter(Boolean);
    const postsCounts = await LeaderboardPost.aggregate([
      { $match: { tagsKey: { $in: tagsKeys } } },
      { $group: { _id: "$tagsKey", count: { $sum: 1 } } },
    ]);
    const postsCountMap = Object.fromEntries(postsCounts.map((p) => [p._id, p.count]));

    const payload = items.map((b) => ({
      _id: b._id,
      tags: b.tags,
      tagsKey: b.tagsKey,
      computedAt: b.computedAt,
      entriesCount: (b.entries || []).length,
      postsCount: postsCountMap[b.tagsKey] || 0,
    }));

    res.json({ ok: true, items: payload, total, page, limit });
  } catch (err) {
    next(err);
  }
}

module.exports = { 
  searchUsers,
  getUserProfile,
  toggleFollow,
  getFollowers,
  getFollowing,
  getUserBookmarks,
  getUserLeaderboards,
};

