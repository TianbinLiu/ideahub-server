const router = require("express").Router();
const { 
  searchUsers, 
  getUserProfile, 
  toggleFollow, 
  getFollowers, 
  getFollowing,
  getUserBookmarks,
} = require("../controllers/users.controller");
const { authenticate, optionalAuth } = require("../middleware/auth");

// GET /api/users/search?q=username&limit=8
router.get("/search", searchUsers);

// GET /api/users/:id - Get user profile (public)
router.get("/:id", optionalAuth, getUserProfile);

// POST /api/users/:id/follow - Follow/unfollow user
router.post("/:id/follow", authenticate, toggleFollow);

// GET /api/users/:id/followers - Get user's followers
router.get("/:id/followers", getFollowers);

// GET /api/users/:id/following - Get users that user follows
router.get("/:id/following", getFollowing);

// GET /api/users/:id/bookmarks - Get user's bookmarks
router.get("/:id/bookmarks", optionalAuth, getUserBookmarks);

module.exports = router;
