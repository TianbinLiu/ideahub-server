// src/routes/promptScheme.routes.js
// 「提示词方案」路由。挂在 /api/branch 下（与卡片/卡组同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/promptScheme.routes"));
//
// ★★ `/schemes/shared` **必须排在 `/schemes/:schemeId` 之前**：反过来的话
//   "shared" 会被当成一个 schemeId，返回 404 或空 —— 而那看起来只是"广场还没人发方案"，
//   是本仓 A2 用例专门钉过的那类**看起来正常的坏**。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { upsertSchemeBody } = require("../schemas/promptScheme.schemas");
const {
  listSchemes,
  upsertScheme,
  removeScheme,
  listSharedSchemes,
  publishScheme,
  unpublishScheme,
  installScheme,
} = require("../controllers/promptScheme.controller");

// 广场：不登录也能逛（挑方案是决定要不要注册的一环）
router.get("/schemes/shared", optionalAuth, listSharedSchemes);

router.get("/schemes", requireAuth, listSchemes);
router.post("/schemes", requireAuth, validate({ body: upsertSchemeBody }), upsertScheme);
router.delete("/schemes/:schemeId", requireAuth, removeScheme);

router.post("/schemes/:schemeId/publish", requireAuth, publishScheme);
router.delete("/schemes/:schemeId/publish", requireAuth, unpublishScheme);
router.post("/schemes/:schemeId/install", requireAuth, installScheme);

module.exports = router;
