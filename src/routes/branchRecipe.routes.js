// src/routes/branchRecipe.routes.js
// 已发布作品的「公开配方」（制作过程），base /api/branch，路径全在 /videos/:id/recipe 下。
// 与 branchVideo.routes 的 /videos/:id、/videos/:id/comments 等不重叠（Express 按完整路径匹配）。
//
// ★ 读是 optionalAuth（没登录的人也能看公开的制作过程，与看作品同一条口径）；写三条全部 requireAuth，
//   「只有作者能碰」的判定在 controller 一处。
// ★ 请求体（配方最大 512KB）走 app.js 里对整个 /api/branch 挂的 jsonGate，这里不再挂一遍。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { recipeBody, recipePatchBody } = require("../schemas/branchRecipe.schemas");
const { putRecipe, patchRecipe, getRecipe, deleteRecipe, listWorkflowTemplates } = require("../controllers/branchRecipe.controller");

// 看制作过程。
// @endpoint GET /api/branch/videos/:id/recipe
//   → { ok, recipe, meta: { video, videoRevision, public, stale, title, author, isOwner, updatedAt } }
//   别人只在「公开 + 描述的正是作品当下这一版」时读得到，否则 404 RECIPE_NOT_PUBLIC
router.get("/videos/:id/recipe", optionalAuth, getRecipe);
// 模板市场的「工作流」货架（上了架的公开配方）。★ 本路由文件在 app.js 里挂在 branchTemplate 之前，
//   这条静态路径才不会被那边的 `/templates/:id` 吃掉
router.get("/templates/workflows", optionalAuth, listWorkflowTemplates);

// 留存 / 覆盖（作者）。
// @endpoint PUT /api/branch/videos/:id/recipe   body { recipe, videoRevision, public? }
//   `videoRevision` 必须等于作品当下的 revision（400 RECIPE_REVISION_MISMATCH）。
// ★ 限流按账号：正常频率是"发布之后自动留存一次 + 编辑页偶尔开关一次"
router.put(
  "/videos/:id/recipe",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 12, scope: "branch:recipe" }),
  validate({ body: recipeBody }),
  putRecipe
);

// 只开 / 关公开（作者）。没有配方时 404 RECIPE_NOT_FOUND
router.patch(
  "/videos/:id/recipe",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 30, scope: "branch:recipe:toggle" }),
  validate({ body: recipePatchBody }),
  patchRecipe
);

// 作者把留存的制作过程整个删掉（作品本身不受影响）
router.delete("/videos/:id/recipe", requireAuth, deleteRecipe);

module.exports = router;
