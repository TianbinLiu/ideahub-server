// src/routes/agentSkill.routes.js
// 「出片技能」路由。挂在 /api/branch 下（与 /schemes /cards /templates 同 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/agentSkill.routes"));
//
// ★★ `/skills/shared` **必须排在 `/skills/:skillId` 相关路由之前**（方案市场 S2 那条坑）：
//   反过来 "shared" 会被当成 skillId，返回看起来只是"广场还没人发技能"，零报错。
const express = require("express");
const router = express.Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { upsertSkillBody } = require("../schemas/agentSkill.schemas");
const c = require("../controllers/agentSkill.controller");

router.get("/skills/shared", optionalAuth, c.listSharedSkills);
router.get("/skills", requireAuth, c.listSkills);
router.post("/skills", requireAuth, validate({ body: upsertSkillBody }), c.upsertSkill);
router.delete("/skills/:skillId", requireAuth, c.removeSkill);
router.post("/skills/:skillId/publish", requireAuth, c.publishSkill);
router.delete("/skills/:skillId/publish", requireAuth, c.unpublishSkill);
router.post("/skills/:skillId/install", requireAuth, c.installSkill);

module.exports = router;
