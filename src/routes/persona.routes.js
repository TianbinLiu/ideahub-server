// src/routes/persona.routes.js
// 人格下载（Persona）路由，base /api/personas。
// 注意：/equipped、/equip 放在 /:id 之前，避免被误捕获为 id。
// 讨论区 /:id/comments 是两段路径，与 /equipped、/equip 这类单段静态路径不可能互相遮蔽
// （段数不同，Express 不会匹配），挂在末尾即可，不影响上面的顺序约束。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { createBody, updateBody, equipBody, generateBody } = require("../schemas/persona.schemas");
const { createBody: commentCreateBody } = require("../schemas/arenaComment.schemas");
const { makeCommentHandlers } = require("../controllers/arenaComment.controller");
const Persona = require("../models/Persona");
const {
  listPersonas,
  getPersona,
  generatePersona,
  createPersona,
  updatePersona,
  removePersona,
  installPersona,
  uninstallPersona,
  togglePersonaLike,
  getEquipped,
  equipPersona,
} = require("../controllers/persona.controller");

const comments = makeCommentHandlers({
  targetType: "persona",
  loadTarget: (id) => Persona.findById(id).select("_id author shared").lean(),
});

router.get("/", optionalAuth, listPersonas);
router.get("/equipped", requireAuth, getEquipped);
router.post("/equip", requireAuth, validate({ body: equipBody }), equipPersona);
// AI 生成入口要限流（评审实锤）：登录用户脚本循环打 12000 字 prompt 的成本无上限。
// 与 OTP 同款 in-memory limiter（按 IP）；5 次/分钟对真人现场生成绰绰有余。
router.post("/generate", requireAuth, rateLimit({ windowMs: 60 * 1000, max: 5 }), validate({ body: generateBody }), generatePersona);
router.post("/", requireAuth, validate({ body: createBody }), createPersona);
router.get("/:id", optionalAuth, getPersona);
router.put("/:id", requireAuth, validate({ body: updateBody }), updatePersona);
router.delete("/:id", requireAuth, removePersona);
router.post("/:id/install", requireAuth, installPersona);
router.delete("/:id/install", requireAuth, uninstallPersona);
router.post("/:id/like", requireAuth, togglePersonaLike);

// ── 人格详情页讨论区 ────────────────────────────────────────────────
router.get("/:id/comments", optionalAuth, comments.list);
router.post("/:id/comments", requireAuth, validate({ body: commentCreateBody }), comments.create);
router.delete("/:id/comments/:commentId", requireAuth, comments.remove);

module.exports = router;
