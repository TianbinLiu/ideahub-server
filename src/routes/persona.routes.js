// src/routes/persona.routes.js
// 人格下载（Persona）路由，base /api/personas。
// 注意：/equipped、/equip 放在 /:id 之前，避免被误捕获为 id。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createBody, updateBody, equipBody } = require("../schemas/persona.schemas");
const {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  removePersona,
  installPersona,
  uninstallPersona,
  togglePersonaLike,
  getEquipped,
  equipPersona,
} = require("../controllers/persona.controller");

router.get("/", optionalAuth, listPersonas);
router.get("/equipped", requireAuth, getEquipped);
router.post("/equip", requireAuth, validate({ body: equipBody }), equipPersona);
router.post("/", requireAuth, validate({ body: createBody }), createPersona);
router.get("/:id", optionalAuth, getPersona);
router.put("/:id", requireAuth, validate({ body: updateBody }), updatePersona);
router.delete("/:id", requireAuth, removePersona);
router.post("/:id/install", requireAuth, installPersona);
router.delete("/:id/install", requireAuth, uninstallPersona);
router.post("/:id/like", requireAuth, togglePersonaLike);

module.exports = router;
