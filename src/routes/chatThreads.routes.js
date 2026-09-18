/**
 * @file chatThreads.routes.js - 数字人对话的会话与记忆：查看、翻历史、手动整理、删除（首页陪聊 + App 客服共用）
 * @category Route
 * @base_path /api/chat
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * 全部需要登录，只能看 / 改 / 删自己的。scene = companion（首页看板娘）| support（App 客服）。
 * 对话本身仍走 POST /api/companion/chat、/api/support/chat（带 threadId）；这里只管「对话之外」的事。
 *
 * API端点:
 * @endpoint GET    /threads?scene=&limit=          - 我的会话列表（按最后活跃倒序），每条带 context 用量
 * @endpoint GET    /threads/:id/messages?before=&limit= - 翻历史（按 seq 倒着分页，返回正序）；含已被提纯的原文与分隔提示
 * @endpoint POST   /threads/:id/compact  {focus?}  - 手动「整理记忆」：只留最后一轮原文，其余提纯；focus 是用户想重点记住的
 * @endpoint POST   /threads/:id/summary/revert     - 摘要回退到上一版
 * @endpoint DELETE /threads/:id                    - 删会话：消息、用量、摘要、从它提炼出的记忆卡，立即硬删
 * @endpoint DELETE /threads?scene=                 - 清空这个场景的全部会话（同上，逐个硬删）
 * @endpoint GET    /memories?scene=                - 「小梦记得的事」
 * @endpoint PATCH  /memories/:id  {text?, pinned?} - 改一条（改文字会留上一版，可回退）
 * @endpoint POST   /memories/:id/revert            - 回退到上一版
 * @endpoint DELETE /memories/:id                   - 删一条
 * @endpoint DELETE /memories?scene=                - 一键清空这个场景的记忆
 *
 * ★ 删除一律硬删（设计稿 §B1），并写 DeletionLog 供备份恢复后重放。
 * ★ 手动整理要调模型 → 按用户限流（每分钟 5 次）；其余接口只读写库。
 *
 * @uses {services/chatMemory.service.js}
 * @uses {middleware/auth.js} - requireAuth
 * @uses {middleware/rateLimit.js} - aiRateLimit
 * @registered_in src/app.js
 */
const express = require("express");
const { z } = require("zod");
const { requireAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { hasAiKey } = require("../services/aiClient");
const chatMemory = require("../services/chatMemory.service");
const ChatThread = require("../models/ChatThread");

const router = express.Router();
router.use(requireAuth);

const sceneQuery = z.object({ scene: z.enum(ChatThread.SCENES) });
const listQuery = sceneQuery.extend({ limit: z.coerce.number().int().min(1).max(100).optional() });
const messagesQuery = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const compactBody = z.object({ focus: z.string().trim().max(200).optional() });
const memoryPatchBody = z
  .object({ text: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() })
  .refine((b) => b.text !== undefined || b.pinned !== undefined, { message: "nothing to update" });

function invalid(res, issues) {
  return res.status(400).json({ ok: false, message: "invalid request", code: "VALIDATION_ERROR", details: issues });
}

router.get("/threads", async (req, res, next) => {
  const q = listQuery.safeParse(req.query || {});
  if (!q.success) return invalid(res, q.error.issues);
  try {
    res.json({ ok: true, threads: await chatMemory.listThreads({ userId: req.user._id, scene: q.data.scene, limit: q.data.limit }) });
  } catch (e) {
    next(e);
  }
});

router.get("/threads/:id/messages", async (req, res, next) => {
  const q = messagesQuery.safeParse(req.query || {});
  if (!q.success) return invalid(res, q.error.issues);
  try {
    res.json({ ok: true, ...(await chatMemory.getMessages({ userId: req.user._id, threadId: req.params.id, before: q.data.before, limit: q.data.limit })) });
  } catch (e) {
    next(e);
  }
});

router.post("/threads/:id/compact", aiRateLimit({ max: 5, scope: "chat-compact" }), async (req, res, next) => {
  const b = compactBody.safeParse(req.body || {});
  if (!b.success) return invalid(res, b.error.issues);
  if (!hasAiKey()) return res.status(501).json({ ok: false, message: "AI not configured", code: "AI_NOT_CONFIGURED" });
  try {
    const thread = await chatMemory.getThread({ userId: req.user._id, threadId: req.params.id });
    const r = await chatMemory.compactThread({ threadId: thread._id, focus: b.data.focus || "", manual: true });
    if (!r.ok && r.reason === "busy") {
      return res.status(409).json({ ok: false, message: "正在整理中，请稍候", code: "CHAT_COMPACT_BUSY" });
    }
    if (!r.ok) {
      return res.status(502).json({ ok: false, message: "整理失败，请稍后再试", code: "CHAT_COMPACT_FAILED", context: r.context });
    }
    res.json({ ok: true, compacted: r.compacted, context: r.context });
  } catch (e) {
    next(e);
  }
});

router.post("/threads/:id/summary/revert", async (req, res, next) => {
  try {
    res.json({ ok: true, thread: await chatMemory.revertSummary({ userId: req.user._id, threadId: req.params.id }) });
  } catch (e) {
    next(e);
  }
});

router.delete("/threads/:id", async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await chatMemory.deleteThread({ userId: req.user._id, threadId: req.params.id })) });
  } catch (e) {
    next(e);
  }
});

router.delete("/threads", async (req, res, next) => {
  const q = sceneQuery.safeParse(req.query || {});
  if (!q.success) return invalid(res, q.error.issues);
  try {
    res.json({ ok: true, ...(await chatMemory.deleteAllThreads({ userId: req.user._id, scene: q.data.scene })) });
  } catch (e) {
    next(e);
  }
});

router.get("/memories", async (req, res, next) => {
  const q = sceneQuery.safeParse(req.query || {});
  if (!q.success) return invalid(res, q.error.issues);
  try {
    res.json({ ok: true, memories: await chatMemory.listMemories({ userId: req.user._id, scene: q.data.scene }) });
  } catch (e) {
    next(e);
  }
});

router.patch("/memories/:id", async (req, res, next) => {
  const b = memoryPatchBody.safeParse(req.body || {});
  if (!b.success) return invalid(res, b.error.issues);
  try {
    res.json({ ok: true, memory: await chatMemory.updateMemory({ userId: req.user._id, id: req.params.id, ...b.data }) });
  } catch (e) {
    next(e);
  }
});

router.post("/memories/:id/revert", async (req, res, next) => {
  try {
    res.json({ ok: true, memory: await chatMemory.revertMemory({ userId: req.user._id, id: req.params.id }) });
  } catch (e) {
    next(e);
  }
});

router.delete("/memories/:id", async (req, res, next) => {
  try {
    await chatMemory.deleteMemory({ userId: req.user._id, id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete("/memories", async (req, res, next) => {
  const q = sceneQuery.safeParse(req.query || {});
  if (!q.success) return invalid(res, q.error.issues);
  try {
    res.json({ ok: true, ...(await chatMemory.clearMemories({ userId: req.user._id, scene: q.data.scene })) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
