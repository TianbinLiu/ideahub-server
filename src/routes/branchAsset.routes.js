// src/routes/branchAsset.routes.js
// 分支视频 · 卡片与卡组路由。挂在 /api/branch 下（与 branchVideo.routes 同一 base，路径不重叠）：
//   app.use("/api/branch", require("./routes/branchAsset.routes"));
// 卡片/卡组本体是用户私有资产（requireAuth）；广场与互动读是 optionalAuth（不登录也要能逛）。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit, userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { addCardsBody, createDeckBody, updateDeckBody, publishBody } = require("../schemas/branchAsset.schemas");
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
  publishCard,
  unpublishCard,
  listSharedCards,
  installCard,
  addAssetView,
  likeAsset,
  unlikeAsset,
  bookmarkAsset,
  unbookmarkAsset,
  getAssetStats,
} = require("../controllers/branchAsset.controller");

// 卡片
// ★ /cards/shared 必须排在 /cards/:cardId 之前，否则会被 :cardId 吃掉
//   （"shared" 当成 cardId → 查不到那张卡 → 广场永远是空的，而且返回 200，一点错都不报）。
//   /decks/shared 下面那条同理，这是本文件唯一一条排序要求。
router.get("/cards/shared", optionalAuth, listSharedCards);
router.get("/cards", requireAuth, listCards);
router.post("/cards", requireAuth, validate({ body: addCardsBody }), addCards);
router.delete("/cards/:cardId", requireAuth, removeCard);

// 卡片分享到创意工坊
router.post("/cards/:cardId/publish", requireAuth, validate({ body: publishBody }), publishCard);
router.delete("/cards/:cardId/publish", requireAuth, unpublishCard);
router.post("/cards/:cardId/install", requireAuth, installCard);

// 卡组
// ★ /decks/shared 必须排在 /decks/:id 之前，否则会被 :id 吃掉（"shared" 当成 id → 400）
router.get("/decks/shared", optionalAuth, listSharedDecks);
router.get("/decks", requireAuth, listDecks);
router.post("/decks", requireAuth, validate({ body: createDeckBody }), createDeck);
router.patch("/decks/:id", requireAuth, validate({ body: updateDeckBody }), updateDeck);
router.delete("/decks/:id", requireAuth, deleteDeck);

// 分享到创意工坊
router.post("/decks/:id/publish", requireAuth, validate({ body: publishBody }), publishDeck);
router.delete("/decks/:id/publish", requireAuth, unpublishDeck);
router.post("/decks/:id/install", requireAuth, installDeck);

// ── 卡片/卡组的互动与热度 ────────────────────────────────────────
// ⚠ 浏览是**匿名可调的 $inc**，必须限频，抄的是 branchVideo.routes 的 /play：
//   60 次/分钟 ≈ 一秒一条详情页，正常人翻不到，脚本刷会立刻撞墙；scope 单列，
//   别和视频播放共用一个桶（否则刷卡片会把看视频的人也限住）。
//   ★ 但限流**只减慢速度、挡不住刷**（60/分钟 × 一小时也够把热度顶上去）。
//     真正的门是 controller 里的 markViewedToday：同一访客同一天只计一次。
//     两道都要，别以为挂了限流就完事了。
router.post(
  "/assets/:kind/:key/view",
  optionalAuth,
  rateLimit({ windowMs: 60 * 1000, max: 60, scope: "branch:assetView" }),
  addAssetView
);

// 点赞/收藏也要限频。它们要登录，但"有个账号"根本不是门槛 —— 这四条每一次调用都在
// upsert（去重表 + 计数表），且都会改热度。按【账号】计（userRateLimit）：按 IP 计的话
// 换个出口就重开一桶，而这里换出口比换账号便宜得多。
// like 与 bookmark 共用一个桶：同一类操作、同一个人在界面上的正常频率也是同一个量级，
// 拆两个桶只是把额度翻倍。POST 与 DELETE 也共用 —— 要刷的是"点了取消、取消再点"。
const assetActionLimit = userRateLimit({ windowMs: 60 * 1000, max: 60, scope: "branch:assetAction" });
router.post("/assets/:kind/:key/like", requireAuth, assetActionLimit, likeAsset);
router.delete("/assets/:kind/:key/like", requireAuth, assetActionLimit, unlikeAsset);
router.post("/assets/:kind/:key/bookmark", requireAuth, assetActionLimit, bookmarkAsset);
router.delete("/assets/:kind/:key/bookmark", requireAuth, assetActionLimit, unbookmarkAsset);
// 读计数不限流也不做存在性校验：它不写库，造不出任何行（见 controller 的说明）
router.get("/assets/:kind/:key/stats", optionalAuth, getAssetStats);

module.exports = router;
