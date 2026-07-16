const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createBody, updateBody, playBody, captureBody, generateBody } = require("../schemas/scenario.schemas");
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

module.exports = router;
