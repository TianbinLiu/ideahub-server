/**
 * @file arena.controller.js - 卢本伟广场 · 插件后端逻辑
 * @category Controller
 * @base_path /api/arena
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md
 *
 * @endpoint POST /api/arena/suggest - 生成三条发言方案（需认证）
 *
 * @uses services/arenaSuggest.service.js - OpenAI 生成方案
 */

const { generateReplySchemes } = require("../services/arenaSuggest.service");

async function suggestReplies(req, res, next) {
  try {
    const { draft, platform, context, persona, count, avoid } = req.body || {};
    const result = await generateReplySchemes({ draft, platform, context, persona, count, avoid });

    if (!result.schemes.length) {
      // 模型没给出可用方案时，用 200 + fallback 标记，交由插件回退本地引擎。
      return res.json({ ok: true, fallback: true, schemes: [], model: result.model });
    }

    res.json({ ok: true, schemes: result.schemes, model: result.model });
  } catch (err) {
    next(err);
  }
}

module.exports = { suggestReplies };
