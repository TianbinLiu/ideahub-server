const router = require("express").Router();
const { 
  searchUsers, 
  getUserProfile, 
  toggleFollow, 
  getFollowers, 
  getFollowing,
  getUserBookmarks,
  getUserIdeas,
  getUserLeaderboards,
  deleteAccount,
} = require("../controllers/users.controller");
const { voteUser, getUserReputation } = require("../controllers/reputation.controller");
const { requireAuth, optionalAuth } = require("../middleware/auth");

// GET /api/users/search?q=username&limit=8
router.get("/search", optionalAuth, searchUsers);

// GET /api/users/:id - Get user profile (public)
router.get("/:id", optionalAuth, getUserProfile);

// POST /api/users/:id/follow - Follow/unfollow user
router.post("/:id/follow", requireAuth, toggleFollow);

// GET /api/users/:id/followers - Get user's followers
router.get("/:id/followers", optionalAuth, getFollowers);

// GET /api/users/:id/following - Get users that user follows
router.get("/:id/following", optionalAuth, getFollowing);

// GET /api/users/:id/bookmarks - Get user's bookmarks
router.get("/:id/bookmarks", optionalAuth, getUserBookmarks);

// GET /api/users/:id/ideas - Get user's visible ideas/dynamics
router.get("/:id/ideas", optionalAuth, getUserIdeas);

// GET /api/users/:id/leaderboards - Get user's leaderboards
router.get("/:id/leaderboards", optionalAuth, getUserLeaderboards);

// POST /api/users/:id/reputation - Vote for user (like/dislike)
router.post("/:userId/reputation", requireAuth, voteUser);

// GET /api/users/:id/reputation - Get user's reputation stats
router.get("/:userId/reputation", optionalAuth, getUserReputation);

// DELETE /api/users/:id - Delete own account (irreversible)
router.delete("/:id", requireAuth, deleteAccount);

module.exports = router;
