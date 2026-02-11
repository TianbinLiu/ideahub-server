const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { requestAiReview } = require("../controllers/aiReview.controller");
const { toggleInterest, listIdeaInterests } = require("../controllers/interest.controller");
const {
  createIdea,
  listIdeas,
  getIdeaById,
  updateIdea,
  deleteIdea,
  listMyIdeas,
} = require("../controllers/ideas.controller");

const {
  toggleLike,
  toggleBookmark,
  listComments,
  addComment,
} = require("../controllers/ideaInteractions.controller");

// 列表：公开（+分页/排序）
router.get("/", listIdeas);

router.get("/mine", requireAuth, listMyIdeas);

// 详情：公开/未列出任何人可看；私密仅作者
router.get("/:id", optionalAuth, getIdeaById);

// 创建：必须登录（Phase 2 已经接了 auth）
router.post("/", requireAuth, createIdea);

// 更新/删除：必须登录，且只能作者
router.put("/:id", requireAuth, updateIdea);
router.delete("/:id", requireAuth, deleteIdea);

// 重要：这些要放在 "/:id" 之后也没问题（它们更具体），但建议放在 "/:id" 之前或之后都可以
router.post("/:id/like", requireAuth, toggleLike);
router.post("/:id/bookmark", requireAuth, toggleBookmark);

router.get("/:id/comments", optionalAuth, listComments); // 读评论不强制登录
router.post("/:id/comments", requireAuth, addComment);

router.post("/:id/ai-review", requireAuth, requestAiReview);

router.post("/:id/interest", requireAuth, toggleInterest);
router.get("/:id/interests", requireAuth, listIdeaInterests);

module.exports = router;
