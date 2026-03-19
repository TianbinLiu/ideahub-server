const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const {
  listTemplates,
  listMyTemplates,
  listTemplateTagInsights,
  getTemplateDetail,
  createTemplate,
  updateTemplate,
  previewAiEdit,
  listTemplateComments,
  addTemplateComment,
  toggleTemplateLike,
  toggleTemplateBookmark,
  applyTemplate,
  getActiveTemplate,
} = require("../controllers/workshop.controller");

router.post("/ai/edit", requireAuth, previewAiEdit);
router.get("/templates", optionalAuth, listTemplates);
router.get("/templates/mine", requireAuth, listMyTemplates);
router.get("/tag-insights", optionalAuth, listTemplateTagInsights);
router.get("/templates/:id", optionalAuth, getTemplateDetail);
router.get("/templates/:id/comments", optionalAuth, listTemplateComments);
router.post("/templates/:id/comments", requireAuth, addTemplateComment);
router.post("/templates", requireAuth, createTemplate);
router.put("/templates/:id", requireAuth, updateTemplate);
router.post("/templates/:id/like", requireAuth, toggleTemplateLike);
router.post("/templates/:id/bookmark", requireAuth, toggleTemplateBookmark);
router.post("/templates/:id/apply", requireAuth, applyTemplate);

router.get("/active-template", requireAuth, getActiveTemplate);

module.exports = router;
