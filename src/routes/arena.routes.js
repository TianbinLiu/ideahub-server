/**
 * @file arena.routes.js - 卢本伟广场 · 插件 API 路由
 * @category Route
 * @base_path /api/arena
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * @endpoint POST /suggest - 生成三条发言方案（需认证，AI 成本敏感）
 *
 * @registered_in app.js - app.use('/api/arena', arenaRoutes)
 */

const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { suggestBody } = require("../schemas/arena.schemas");
const { suggestReplies } = require("../controllers/arena.controller");

router.post("/suggest", requireAuth, validate({ body: suggestBody }), suggestReplies);

module.exports = router;
