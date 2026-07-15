// src/routes/speakingStyle.routes.js
// 发言风格面板（Speaking Style Panel）路由，base /api/speaking-style。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { generateBody } = require("../schemas/speakingStyle.schemas");
const { getMine, generate, getByUser } = require("../controllers/speakingStyle.controller");

router.get("/", requireAuth, getMine);
router.post("/generate", requireAuth, validate({ body: generateBody }), generate);
router.get("/user/:userId", optionalAuth, getByUser);

module.exports = router;
