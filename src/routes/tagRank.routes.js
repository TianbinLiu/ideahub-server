const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { getRank, vote } = require("../controllers/tagRank.controller");

// GET /api/tag-rank?tags=tag1,tag2
router.get("/", optionalAuth, getRank);

// POST /api/tag-rank/vote { ideaId, tags, vote }
router.post("/vote", requireAuth, vote);

module.exports = router;
