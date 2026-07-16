// src/routes/speakingStyle.routes.js
// 发言风格面板（Speaking Style Panel）路由，base /api/speaking-style。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { generateBody, samplesBody } = require("../schemas/speakingStyle.schemas");
const {
  getMine,
  generate,
  getByUser,
  addSamples,
  listSamples,
  deleteSample,
  clearSamples,
} = require("../controllers/speakingStyle.controller");

router.get("/", requireAuth, getMine);
router.post("/generate", requireAuth, validate({ body: generateBody }), generate);

// 风格记忆样本：只收录用户自己提供的发言（粘贴 / 插件在本人主页评论页就地收集）
router.post("/samples", requireAuth, validate({ body: samplesBody }), addSamples);
router.get("/samples", requireAuth, listSamples);
router.delete("/samples/:id", requireAuth, deleteSample);
router.delete("/samples", requireAuth, clearSamples);

router.get("/user/:userId", optionalAuth, getByUser);

module.exports = router;
