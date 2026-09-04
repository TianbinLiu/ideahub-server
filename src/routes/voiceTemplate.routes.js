/**
 * @file voiceTemplate.routes.js - 声音市场（豆包 1.0 混音模板：1～3 味音色按权重调出一把嗓子）
 * @category Route
 * @base_path /api/voice-templates
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * API端点:
 * @endpoint GET    /          - 广场列表（?page&limit(≤40)&sort=new|hot&q&scope=all|mine）→ { ok, templates, total, page, limit, totalPages }；
 *                               all = 已分享的，mine 未登录 401
 * @endpoint GET    /:id       - 详情；私有且非作者 403
 * @endpoint POST   /          - 创建（登录 + 按用户 10 次/分钟）：{ name(1..60), description?(≤300), recipe[1..3]{voiceId,weight}, rate?, pitch?, instruct?, expressive?, shared? } → 201
 * @endpoint PUT    /:id       - 作者改，同字段可选
 * @endpoint DELETE /:id       - 作者删：连点赞一起删；引用它的数字人设置 / 人格 / 模型只把 templateId 置 null（配方快照保留，嗓子不变）
 * @endpoint POST   /:id/like  - 点赞开关 → { ok, liked, likeCount }
 * @endpoint POST   /:id/use   - 使用计数 → { ok, useCount }：前端把模板应用到数字人 / 人格 / 模型时调一次
 *
 * VoiceTemplate 载荷：{ _id, author{_id,username}, name, description, recipe[{voiceId,weight}](权重和 = 1、三位小数),
 *   rate, pitch, instruct, expressive, shared, stats{useCount,likeCount}, liked, isOwner, createdAt, updatedAt,
 *   voice: VoiceSettings（由 recipe/rate/pitch/instruct 拼好、templateId=_id 的快照，前端直接塞进 settings.voice） }
 *
 * ★ recipe 只收 config/voices.js 的 MIXABLE_VOICES（23 个验证过的 1.0 音色），2.0 进来是 400（message 说明只能混 1.0）。
 * ★ 「使用」是快照语义：用户手里存的是配方而不是模板 id，作者改 / 删都不影响已使用的人（见 models/VoiceTemplate.js）。
 *
 * @uses {controllers/voiceTemplate.controller.js}
 * @uses {services/voiceTemplate.service.js} - 序列化、{ templateId } 展开、删模板解引用
 * @registered_in src/app.js
 */
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { createBody, updateBody } = require("../schemas/voiceTemplate.schemas");
const ctrl = require("../controllers/voiceTemplate.controller");

// ★ 列表的 query 在控制器里自己 parse：Express 5 的 req.query 是只读 getter，validate() 的 `req.query = …` 会被静默吞掉
router.get("/", optionalAuth, ctrl.listTemplates);
router.post("/", requireAuth, userRateLimit({ max: 10, scope: "voice-template" }), validate({ body: createBody }), ctrl.createTemplate);
router.get("/:id", optionalAuth, ctrl.getTemplate);
router.put("/:id", requireAuth, validate({ body: updateBody }), ctrl.updateTemplate);
router.delete("/:id", requireAuth, ctrl.removeTemplate);
router.post("/:id/like", requireAuth, ctrl.toggleLike);
router.post("/:id/use", requireAuth, ctrl.useTemplate);

module.exports = router;
