// src/routes/scenario.routes.js
// 情景模拟（Scenario Simulation）路由，base /api/scenarios。
// 注意：/mine、/capture、/generate 是静态单段路径，必须排在 /:id 之前，否则会被 :id 捕获。
// 讨论区 /:id/comments 是两段路径，与上述单段静态路径不会互相遮蔽，挂在末尾即可。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createBody, updateBody, playBody, captureBody, generateBody } = require("../schemas/scenario.schemas");
const { createBody: commentCreateBody } = require("../schemas/arenaComment.schemas");
const { makeCommentHandlers } = require("../controllers/arenaComment.controller");
const Scenario = require("../models/Scenario");
const {
  listScenarios,
  listMyScenarios,
  getScenarioDetail,
  createScenario,
  updateScenario,
  removeScenario,
  toggleScenarioLike,
  toggleScenarioBookmark,
  playScenario,
  captureScenario,
  generateScenario,
} = require("../controllers/scenario.controller");

const comments = makeCommentHandlers({
  targetType: "scenario",
  loadTarget: (id) => Scenario.findById(id).select("_id author shared").lean(),
});

router.get("/", optionalAuth, listScenarios);
router.get("/mine", requireAuth, listMyScenarios);
router.post("/", requireAuth, validate({ body: createBody }), createScenario);
router.post("/capture", requireAuth, validate({ body: captureBody }), captureScenario);
router.post("/generate", requireAuth, validate({ body: generateBody }), generateScenario);
router.get("/:id", optionalAuth, getScenarioDetail);
router.put("/:id", requireAuth, validate({ body: updateBody }), updateScenario);
router.delete("/:id", requireAuth, removeScenario);
router.post("/:id/like", requireAuth, toggleScenarioLike);
router.post("/:id/bookmark", requireAuth, toggleScenarioBookmark);
router.post("/:id/play", requireAuth, validate({ body: playBody }), playScenario);

// ── 情景详情页讨论区（与模拟页的仿真评论 ScenarioMessage 无关）──────────
router.get("/:id/comments", optionalAuth, comments.list);
router.post("/:id/comments", requireAuth, validate({ body: commentCreateBody }), comments.create);
router.delete("/:id/comments/:commentId", requireAuth, comments.remove);

module.exports = router;
