const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { getAiJob } = require("../controllers/aiJobs.controller");

router.get("/:id", requireAuth, getAiJob);

module.exports = router;
