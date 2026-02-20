const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { getRank, vote, createLeaderboard, listLeaderboards } = require("../controllers/tagRank.controller");

// GET /api/tag-rank?tags=tag1,tag2
router.get("/", optionalAuth, getRank);

// POST /api/tag-rank/leaderboard { tags }
router.post("/leaderboard", createLeaderboard);
// GET /api/tag-rank/leaderboards
router.get("/leaderboards", optionalAuth, listLeaderboards);
// GET /api/tag-rank/suggest?q=xxx
router.get("/suggest", optionalAuth, require("../controllers/tagRank.controller").suggestTags || ((req,res)=>res.json({ok:true, tags:[] }))); 

// POST /api/tag-rank/vote { ideaId, tags, vote }
router.post("/vote", requireAuth, vote);

module.exports = router;
