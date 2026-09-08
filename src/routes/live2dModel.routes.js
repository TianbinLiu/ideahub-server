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
 * @endpoint POST   /bundle/sign - 出一张 Cloudinary raw(zip) 直传票（App 上传向导用，绕开 CF 125 秒读超时）；按用户 5 次/分钟 + 20 次/天
 * @endpoint POST   /inspect     - 只看不存（向导第 3 步）：bundle=zip → { entries, entry, capabilities, mapping(自动), completeness, warnings }；按用户 10 次/分钟
 * @endpoint POST   /            - 上传（multipart：bundle=zip ≤25MB **或** bundleRef=直传回来的 public_id + name/description/coverImageUrl/tags/shared/personaId/voice(JSON) + mapping(JSON, companion.json 内容，缺省自动映射) + entry + selfMade）；回包多 warnings / entries
 * @endpoint PUT    /:id         - 作者改元数据 / 换绑人格 / 改推荐嗓子 / 改映射 mapping（对象 = 校验后重写 companion.json，null = 恢复自动映射）/ selfMade（JSON）
 * @endpoint DELETE /:id         - 作者删除：连解压目录、收藏、点赞一起删；正在用它的用户回到官方看板娘
 * @endpoint POST   /:id/install / DELETE /:id/install - 收藏下载（downloadCount）
 * @endpoint POST   /:id/like    - 点赞开关
 *
 * ★ 上传顺序：requireAuth → 按用户限流（5 次/分钟，解压是 CPU + 磁盘活）→ multer 收 zip → zod 校验文本字段 → 控制器。
 *   zod 必须排在 multer 之后：multipart 的文本字段要 multer 解析完才在 req.body 里。
 * ★ 解压白名单 / zip-bomb 记账 / model3.json 校验都在 services/live2dBundle.service.js，与 /api/me/components/live2d/upload 同一份。
 * ★ 能力档案（动作组 / 表情 / 命中区 / 参数 / 物理）与 companion.json 映射的提取、自动映射、校验在 services/live2dCapabilities.service.js（唯一实现，客户端不自己猜）。
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
// 直传票：App 侧 25MB 的 zip 不可能走 multipart（Cloudflare 125 秒读超时），必须客户端直传 Cloudinary。
// ★ 两道限流叠着：分钟闸挡脚本，天闸给"出票后不用"的泄漏兜底（那份 raw 资产没人回收）。
router.post(
  "/bundle/sign",
  requireAuth,
  userRateLimit({ max: 5, windowMs: 60 * 1000, scope: "live2d-bundle-sign" }),
  userRateLimit({ max: 20, windowMs: 24 * 60 * 60 * 1000, scope: "live2d-bundle-sign-day" }),
  ctrl.signBundleUpload,
);
// 只看不存：向导第 3 步用它拿能力档案 + 自动映射 + 入口候选（解到 uploads/tmp-inspect/ 临时目录，返回前删掉）
router.post("/inspect", requireAuth, userRateLimit({ max: 10, scope: "live2d-inspect" }), uploadLive2dBundle.single("bundle"), ctrl.inspectModel);
router.get("/:id", optionalAuth, ctrl.getModel);
router.put("/:id", requireAuth, validate({ body: updateBody }), ctrl.updateModel);
router.delete("/:id", requireAuth, ctrl.removeModel);
router.post("/:id/install", requireAuth, ctrl.installModel);
router.delete("/:id/install", requireAuth, ctrl.uninstallModel);
router.post("/:id/like", requireAuth, ctrl.toggleLike);

module.exports = router;
