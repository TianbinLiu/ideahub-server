const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

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
  likeComment,
} = require("../controllers/ideaInteractions.controller");

const { createIdeaBody, updateIdeaBody } = require("../schemas/idea.schemas");
const { addCommentBody } = require("../schemas/comment.schemas");

// 列表：公开（+分页/排序）
router.get("/", listIdeas);

// title suggestions for autocomplete
router.get("/suggest", require("../controllers/ideas.controller").suggestTitles || ((req,res)=>res.json({ok:true, ideas:[]})));

router.get("/mine", requireAuth, listMyIdeas);

// 详情：公开/未列出任何人可看；私密仅作者
router.get("/:id", optionalAuth, getIdeaById);

// 创建：必须登录
router.post("/", requireAuth, validate({ body: createIdeaBody }), createIdea);

// 更新/删除：必须登录，且只能作者
router.put("/:id", requireAuth, validate({ body: updateIdeaBody }), updateIdea);
router.delete("/:id", requireAuth, deleteIdea);

// 互动
router.post("/:id/like", requireAuth, toggleLike);
router.post("/:id/bookmark", requireAuth, toggleBookmark);

router.get("/:id/comments", optionalAuth, listComments);
router.post("/:id/comments", requireAuth, validate({ body: addCommentBody }), addComment);
router.post("/:id/comments/:commentId/like", requireAuth, likeComment);

router.post("/:id/ai-review", requireAuth, requestAiReview);

router.post("/:id/interest", requireAuth, toggleInterest);
router.get("/:id/interests", requireAuth, listIdeaInterests);

module.exports = router;
