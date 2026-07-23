// src/routes/feed.routes.js
// 关注流，base /api/feed。
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { listFollowingFeed } = require("../controllers/feed.controller");

router.get("/following", requireAuth, listFollowingFeed);

module.exports = router;
