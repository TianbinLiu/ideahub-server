// src/routes/meme.routes.js
// 表情/梗图库（Meme）路由，base /api/memes。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createBody, updateBody, useBody } = require("../schemas/meme.schemas");
const {
  listMemes,
  getMeme,
  createMeme,
  updateMeme,
  removeMeme,
  collectMeme,
  uncollectMeme,
  useMeme,
} = require("../controllers/meme.controller");

router.get("/", optionalAuth, listMemes);
router.post("/", requireAuth, validate({ body: createBody }), createMeme);
router.get("/:id", optionalAuth, getMeme);
router.put("/:id", requireAuth, validate({ body: updateBody }), updateMeme);
router.delete("/:id", requireAuth, removeMeme);
router.post("/:id/collect", requireAuth, collectMeme);
router.delete("/:id/collect", requireAuth, uncollectMeme);
router.post("/:id/use", requireAuth, validate({ body: useBody }), useMeme);

module.exports = router;
