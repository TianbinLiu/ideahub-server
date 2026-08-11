// src/routes/branchVideo.routes.js
// 分支视频（ideahub-app）路由，base /api/branch。
// 本文件只负责 /videos 相关端点；/cards 与 /decks 由 branchAsset.routes.js 提供，挂在同一 base 下。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { publishBody, updateBody, commentBody, danmakuBody } = require("../schemas/branchVideo.schemas");
const {
  listVideos,
  createVideo,
  getVideo,
  updateVideo,
  removeVideo,
  addPlay,
  likeVideo,
  unlikeVideo,
  listComments,
  addComment,
  listDanmaku,
  addDanmaku,
} = require("../controllers/branchVideo.controller");

// 列表 query 的校验放在 controller 里（Express 5 的 req.query 只读，validate({query}) 会静默失效）
router.get("/videos", optionalAuth, listVideos);
router.post("/videos", requireAuth, validate({ body: publishBody }), createVideo);
router.get("/videos/:id", optionalAuth, getVideo);
// 作品编辑：只改标题/简介/分区/可见性。片段与卡组不可改（发布即定稿）
router.patch("/videos/:id", requireAuth, validate({ body: updateBody }), updateVideo);
router.delete("/videos/:id", requireAuth, removeVideo);

// 播放计数保持匿名可调（未登录也要能看视频），但必须限频：
// 这是个无鉴权的 $inc，不限的话一个循环就能把任意视频刷到榜首。
router.post("/videos/:id/play", optionalAuth, rateLimit({ windowMs: 60 * 1000, max: 60, scope: "branch:play" }), addPlay);
router.post("/videos/:id/like", requireAuth, likeVideo);
router.delete("/videos/:id/like", requireAuth, unlikeVideo);

router.get("/videos/:id/comments", optionalAuth, listComments);
router.post("/videos/:id/comments", requireAuth, validate({ body: commentBody }), addComment);

// 弹幕。读匿名可调（不登录也要看得到别人的弹幕），发必须登录。
// ★ 发弹幕**必须限频**，而且比评论严得多：它是一句话的成本、能盖在别人的画面上，
//   是这套 API 里最适合拿来刷屏的一条。30 条/分钟 ≈ 两秒一条 —— 正常人边看边发
//   够用了，脚本刷屏则会被挡住。scope 单列，别和评论共用一个桶。
router.get("/videos/:id/danmaku", optionalAuth, listDanmaku);
router.post(
  "/videos/:id/danmaku",
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 30, scope: "branch:danmaku" }),
  validate({ body: danmakuBody }),
  addDanmaku
);

// 卡片 / 卡组（/cards、/decks）由另一个模块提供。
// 该文件可能尚未落地（并行开发），缺失时只告警不炸掉整个 app。
try {
  router.use(require("./branchAsset.routes"));
} catch (err) {
  const selfMissing =
    err && err.code === "MODULE_NOT_FOUND" && /branchAsset\.routes/.test(String(err.message || ""));
  if (!selfMissing) throw err;
  console.warn("[branch] branchAsset.routes 未就绪，/api/branch/cards 与 /api/branch/decks 暂不可用");
}

module.exports = router;
