// src/routes/branchAsset.routes.js
// 分支视频 · 卡片与卡组路由。挂在 /api/branch 下（与 branchVideo.routes 同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/branchAsset.routes"));
// 全部端点都要登录——卡片/卡组是用户私有资产。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { addCardsBody, createDeckBody, updateDeckBody } = require("../schemas/branchAsset.schemas");
const {
  listCards,
  addCards,
  removeCard,
  listDecks,
  createDeck,
  updateDeck,
  deleteDeck,
  publishDeck,
  unpublishDeck,
  listSharedDecks,
  installDeck,
} = require("../controllers/branchAsset.controller");

// 卡片
router.get("/cards", requireAuth, listCards);
router.post("/cards", requireAuth, validate({ body: addCardsBody }), addCards);
router.delete("/cards/:cardId", requireAuth, removeCard);

// 卡组
// ★ /decks/shared 必须排在 /decks/:id 之前，否则会被 :id 吃掉（"shared" 当成 id → 400）
router.get("/decks/shared", optionalAuth, listSharedDecks);
router.get("/decks", requireAuth, listDecks);
router.post("/decks", requireAuth, validate({ body: createDeckBody }), createDeck);
router.patch("/decks/:id", requireAuth, validate({ body: updateDeckBody }), updateDeck);
router.delete("/decks/:id", requireAuth, deleteDeck);

// 分享到创意工坊
router.post("/decks/:id/publish", requireAuth, publishDeck);
router.delete("/decks/:id/publish", requireAuth, unpublishDeck);
router.post("/decks/:id/install", requireAuth, installDeck);

module.exports = router;
