/**
 * @file live2dModel.routes.js - Live2D 模型市场（数字人套装：模型包 + 推荐人格 + 推荐嗓子）
 * @category Route
 * @base_path /api/live2d-models
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * API端点:
 * @endpoint GET    /            - 广场列表（?page&limit&sort=new|hot&q&tag&scope=all|installed|mine）；scope=all 第一页最前面是官方内置条目
 * @endpoint GET    /:id         - 详情（$inc viewCount）；"official-mascot" 回官方内置条目
 * @endpoint POST   /            - 上传（multipart：bundle=zip ≤25MB + name/description/coverImageUrl/tags/shared/personaId/voice(JSON)）
 * @endpoint PUT    /:id         - 作者改元数据 / 换绑人格 / 改推荐嗓子（JSON）
 * @endpoint DELETE /:id         - 作者删除：连解压目录、收藏、点赞一起删；正在用它的用户回到官方看板娘
 * @endpoint POST   /:id/install / DELETE /:id/install - 收藏下载（downloadCount）
 * @endpoint POST   /:id/like    - 点赞开关
 *
 * ★ 上传顺序：requireAuth → 按用户限流（5 次/分钟，解压是 CPU + 磁盘活）→ multer 收 zip → zod 校验文本字段 → 控制器。
 *   zod 必须排在 multer 之后：multipart 的文本字段要 multer 解析完才在 req.body 里。
 * ★ 解压白名单 / zip-bomb 记账 / model3.json 校验都在 services/live2dBundle.service.js，与 /api/me/components/live2d/upload 同一份。
 *
 * @uses {controllers/live2dModel.controller.js}
 * @uses {services/live2dBundle.service.js} - uploadLive2dBundle（multer）
 * @registered_in src/app.js
 */
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { createBody, updateBody } = require("../schemas/live2dModel.schemas");
const { uploadLive2dBundle } = require("../services/live2dBundle.service");
const ctrl = require("../controllers/live2dModel.controller");

// ★ 列表的 query 在控制器里自己 parse：Express 5 的 req.query 是只读 getter，validate() 的 `req.query = …` 会被静默吞掉
router.get("/", optionalAuth, ctrl.listModels);
router.post(
  "/",
  requireAuth,
  userRateLimit({ max: 5, scope: "live2d-upload" }),
  uploadLive2dBundle.single("bundle"),
  validate({ body: createBody }),
  ctrl.createModel
);
router.get("/:id", optionalAuth, ctrl.getModel);
router.put("/:id", requireAuth, validate({ body: updateBody }), ctrl.updateModel);
router.delete("/:id", requireAuth, ctrl.removeModel);
router.post("/:id/install", requireAuth, ctrl.installModel);
router.delete("/:id/install", requireAuth, ctrl.uninstallModel);
router.post("/:id/like", requireAuth, ctrl.toggleLike);

module.exports = router;
