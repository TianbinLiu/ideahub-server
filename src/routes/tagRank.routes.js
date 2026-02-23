const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { getRank, vote, createLeaderboard, listLeaderboards, getLeaderboardById, searchLeaderboards } = require("../controllers/tagRank.controller");
const { createPost, listPosts, likePost } = require("../controllers/leaderboard.controller");

// GET /api/tag-rank?tags=tag1,tag2
router.get("/", optionalAuth, getRank);

// GET /api/tag-rank/search?q=tag1,tag2
router.get("/search", optionalAuth, searchLeaderboards);

// GET /api/tag-rank/suggest?q=xxx
router.get("/suggest", optionalAuth, require("../controllers/tagRank.controller").suggestTags || ((req,res)=>res.json({ok:true, tags:[] }))); 

// POST /api/tag-rank/leaderboard { tags }
router.post("/leaderboard", createLeaderboard);

// GET /api/tag-rank/leaderboards?sort=recent|hottest
router.get("/leaderboards", optionalAuth, listLeaderboards);

// GET /api/tag-rank/leaderboards/:id
router.get("/leaderboards/:id", optionalAuth, getLeaderboardById);

// POST /api/tag-rank/vote { ideaId, tags, vote }
router.post("/vote", requireAuth, vote);

// leaderboard posts
router.get("/posts", optionalAuth, listPosts); // ?tagsKey=...&sort=popular
router.post("/posts", requireAuth, createPost);
router.post("/posts/:id/like", requireAuth, likePost);

module.exports = router;
