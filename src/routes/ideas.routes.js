/**
 * @file ideas.routes.js - 创意相关API路由
 * @category Route
 * @base_path /api/ideas
 * 
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 * 
 * API端点:
 * @endpoint GET / - 获取创意列表（公开，分页+排序+搜索）
 * @endpoint POST / - 创建新创意（需认证）
 * @endpoint GET /me - 获取我的创意列表（需认证）
 * @endpoint GET /:id - 获取创意详情（公开/私密需权限）
 * @endpoint PATCH /:id - 更新创意（需作者或管理员）
 * @endpoint DELETE /:id - 删除创意（需作者或管理员）
 * @endpoint POST /:id/like - 点赞/取消点赞（需认证）
 * @endpoint POST /:id/bookmark - 收藏/取消收藏（需认证）
 * @endpoint GET /:id/comments - 获取评论列表（公开）
 * @endpoint POST /:id/comments - 添加评论（需认证）
 * @endpoint POST /:id/comments/:commentId/like - 点赞评论（需认证）
 * @endpoint POST /:id/comments/:commentId/dislike - 点踩评论（需认证）
 * @endpoint POST /:id/ai-review - 请求AI评审（需认证）
 * @endpoint POST /:id/interest - 公司表达兴趣（需company角色）
 * @endpoint GET /:id/interests - 获取创意的兴趣表达列表
 * 
 * 依赖:
 * @uses controllers/ideas.controller.js - 创意 CRUD 逻辑
 * @uses controllers/ideaInteractions.controller.js - 点赞、评论、收藏逻辑
 * @uses controllers/aiReview.controller.js - AI评审逻辑
 * @uses controllers/interest.controller.js - 公司兴趣逻辑
 * @uses middleware/auth.js - 认证和权限检查
 * @uses middleware/validate.js - 请求数据验证
 * @uses schemas/idea.schemas.js - 创意验证规则
 * @uses schemas/comment.schemas.js - 评论验证规则
 * 
 * 认证要求:
 * - POST/PATCH/DELETE 需要 requireAuth
 * - PATCH/DELETE 需要作者或 admin 角色
 * - POST /:id/interest 需要 company 角色
 * 
 * 被注册于:
 * @registered_in app.js - Express应用 (app.use('/api/ideas', ideasRoutes))
 */

const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

const { requestAiReview } = require("../controllers/aiReview.controller");
const { toggleInterest, listIdeaInterests } = require("../controllers/interest.controller");

const {
  createIdea,
  listIdeas,
  generateIdeaDraft,
  getIdeaById,
  updateIdea,
  deleteIdea,
  listMyIdeas,
  submitRecommendationFeedback,
  clearRecommendationFeedback,
} = require("../controllers/ideas.controller");

const {
  toggleLike,
  toggleBookmark,
  listComments,
  addComment,
  likeComment,
  dislikeComment,
  deleteComment,
  listCommentReplies,
} = require("../controllers/ideaInteractions.controller");

const { createIdeaBody, updateIdeaBody, recommendationFeedbackBody } = require("../schemas/idea.schemas");
const { addCommentBody } = require("../schemas/comment.schemas");

// 列表：公开（+分页/排序）
router.get("/", optionalAuth, listIdeas);

// title suggestions for autocomplete
router.get("/suggest", require("../controllers/ideas.controller").suggestTitles || ((req,res)=>res.json({ok:true, ideas:[]})));

router.get("/mine", requireAuth, listMyIdeas);

router.post("/draft", requireAuth, generateIdeaDraft);

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
router.post("/:id/recommendation-feedback", requireAuth, validate({ body: recommendationFeedbackBody }), submitRecommendationFeedback);
router.delete("/:id/recommendation-feedback", requireAuth, clearRecommendationFeedback);

router.get("/:id/comments", optionalAuth, listComments);
router.post("/:id/comments", requireAuth, validate({ body: addCommentBody }), addComment);
router.get("/:id/comments/:commentId/replies", optionalAuth, listCommentReplies);
router.post("/:id/comments/:commentId/like", requireAuth, likeComment);
router.post("/:id/comments/:commentId/dislike", requireAuth, dislikeComment);
router.delete("/:id/comments/:commentId", requireAuth, deleteComment);

router.post("/:id/ai-review", requireAuth, requestAiReview);

router.post("/:id/interest", requireAuth, toggleInterest);
router.get("/:id/interests", requireAuth, listIdeaInterests);

module.exports = router;
