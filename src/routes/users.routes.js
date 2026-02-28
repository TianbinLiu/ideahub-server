const router = require("express").Router();
const { 
  searchUsers, 
  getUserProfile, 
  toggleFollow, 
  getFollowers, 
  getFollowing,
  getUserBookmarks,
  getUserLeaderboards,
} = require("../controllers/users.controller");
const { voteUser, getUserReputation } = require("../controllers/reputation.controller");
const { requireAuth, optionalAuth } = require("../middleware/auth");

// GET /api/users/search?q=username&limit=8
router.get("/search", searchUsers);

// GET /api/users/:id - Get user profile (public)
router.get("/:id", optionalAuth, getUserProfile);

// POST /api/users/:id/follow - Follow/unfollow user
router.post("/:id/follow", requireAuth, toggleFollow);

// GET /api/users/:id/followers - Get user's followers
router.get("/:id/followers", getFollowers);

// GET /api/users/:id/following - Get users that user follows
router.get("/:id/following", getFollowing);

// GET /api/users/:id/bookmarks - Get user's bookmarks
router.get("/:id/bookmarks", optionalAuth, getUserBookmarks);

// GET /api/users/:id/leaderboards - Get user's leaderboards
router.get("/:id/leaderboards", optionalAuth, getUserLeaderboards);

// POST /api/users/:id/reputation - Vote for user (like/dislike)
router.post("/:userId/reputation", requireAuth, voteUser);

// GET /api/users/:id/reputation - Get user's reputation stats
router.get("/:userId/reputation", optionalAuth, getUserReputation);

module.exports = router;
