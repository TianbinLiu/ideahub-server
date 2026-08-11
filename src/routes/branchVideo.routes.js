// src/routes/branchVideo.routes.js
// 分支视频（ideahub-app）路由，base /api/branch。
// 本文件只负责 /videos 相关端点；/cards 与 /decks 由 branchAsset.routes.js 提供，挂在同一 base 下。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit, userRateLimit } = require("../middleware/rateLimit");
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
  removeComment,
  likeComment,
  unlikeComment,
  listDanmaku,
  addDanmaku,
  removeDanmaku,
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

// 点赞/取消也要限频，而且 POST 与 DELETE **共用一个桶**：要刷的从来不是"一直点赞"
// （那是幂等的），而是"取消 → 再点 → 取消 → 再点"，两条路各给一份额度等于没限。
// 按【账号】计（userRateLimit）：这两条在 requireAuth 后面，按 IP 计的话换个出口就重开一桶。
// 60/分钟 ≈ 一秒一次，正常人在一个界面上点不到这个频率。
const likeLimit = userRateLimit({ windowMs: 60 * 1000, max: 60, scope: "branch:like" });
router.post("/videos/:id/like", requireAuth, likeLimit, likeVideo);
router.delete("/videos/:id/like", requireAuth, likeLimit, unlikeVideo);

router.get("/videos/:id/comments", optionalAuth, listComments);
// ★ 发评论也要限频，而且**单开一个桶**，不和 branch:danmaku 共用：共用的话
//   一个人边看边发弹幕就会把自己的评论额度一起吃掉（两件事的正常频率差一个量级）。
//   20/分钟 ≈ 三秒一条：正常人打字都来不及，脚本刷楼会被挡住。
// ★★ 必须是 userRateLimit（按账号）而不是 rateLimit（按 IP）——
//   这条路由在 requireAuth 后面，攻击者手上已经有一个合法账号了，按 IP 计等于
//   "换个出口就重开一桶"（手机切流量、代理池，成本近乎零）。而这**恰恰是**唯一一条
//   会向陌生人扇出通知的端点：一条评论最多解析 10 个 @提及，20 条/分钟 × 10 = 200 条
//   通知/分钟砸进别人的收件箱，换个 IP 就能再来一轮。
//   反向的误伤同样真实：按 IP 计时，办公室/校园网/运营商 CGNAT 后面的所有人共用
//   这一个 20/分钟 的桶 —— 一个同事发满 20 条，隔壁一条都没发过的人就 429。
//   （同一条理由写在 rateLimit.js 的 userRateLimit 注释里，那里是这条规则的出处。）
router.post(
  "/videos/:id/comments",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 20, scope: "branch:comment" }),
  validate({ body: commentBody }),
  addComment
);

// 评论点赞。★ 挂在 /videos/:id 下面而不是单开一个 /comments/:commentId ——
// 分支视频的每一条子端点都要过 assertVisible(作品可见性)，脱开作品 id 就没法判，
// 那条评论也就成了探测私密作品内容的旁路（与弹幕端点同源，见 controller 的说明）。
// scope 单列，别和作品点赞共用一个桶：评论区一屏十几条，逐条点赞是正常操作，
// 和"对同一条作品反复点"的正常频率差一个量级，共用会把正常用户误伤在评论区里。
const commentLikeLimit = userRateLimit({ windowMs: 60 * 1000, max: 60, scope: "branch:commentLike" });
router.post("/videos/:id/comments/:commentId/like", requireAuth, commentLikeLimit, likeComment);
router.delete("/videos/:id/comments/:commentId/like", requireAuth, commentLikeLimit, unlikeComment);

// 删评论：评论作者本人 或 作品作者。
// ★ **单开一个桶**，不与 branch:comment（发评论）共用：删是不可逆的，共用的话
//   "清理自己作品下的一片刷屏评论"会把自己接下来发言的额度一起吃掉。
// ★ 也不与点赞那样把 POST/DELETE 合桶：点赞合桶是因为要刷的是"取消→再点"这个**来回**，
//   而删除没有来回（删掉就没了），合桶只会平白误伤。
// ★ 按【账号】计（userRateLimit）：这条在 requireAuth 后面，按 IP 计等于换个出口就重开一桶，
//   同时又会让同一个 NAT 后面的真人互相抢额度（理由与发评论那条逐字相同）。
// 30/分钟：作品作者手动清理一片刷屏够用，脚本批量删会撞墙。
const commentDeleteLimit = userRateLimit({ windowMs: 60 * 1000, max: 30, scope: "branch:commentDelete" });
router.delete("/videos/:id/comments/:commentId", requireAuth, commentDeleteLimit, removeComment);

// 弹幕。读匿名可调（不登录也要看得到别人的弹幕），发必须登录。
// ★ 发弹幕**必须限频**，而且比评论严得多：它是一句话的成本、能盖在别人的画面上，
//   是这套 API 里最适合拿来刷屏的一条。30 条/分钟 ≈ 两秒一条 —— 正常人边看边发
//   够用了，脚本刷屏则会被挡住。scope 单列，别和评论共用一个桶。
// ★ 同样按【账号】计：这条也在 requireAuth 后面，理由与上面发评论那条逐字相同
//   （按 IP 计既挡不住换出口的人，又会让同一个 NAT 后面的真人互相抢额度）。
//   本文件里还留着按 IP 计的只有 /play 一条 —— 那条是 optionalAuth，游客也要能调，
//   而 userRateLimit 的 keyFor 对游客返回 null 会**直接放行**（见 rateLimit.js 的警告），
//   所以那里按 IP 才是对的。判据是"这条路由要不要登录"，不是"哪个更严"。
router.get("/videos/:id/danmaku", optionalAuth, listDanmaku);
router.post(
  "/videos/:id/danmaku",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 30, scope: "branch:danmaku" }),
  validate({ body: danmakuBody }),
  addDanmaku
);
// 删弹幕：弹幕作者本人 或 作品作者。桶与"发弹幕"分开，理由同上面删评论那条。
// ⚠ 这条端点的回包与错误文案**绝不能透出作者是谁**（见 controller 的说明）：
//   弹幕对外只有一个 mine 布尔，一句"这条属于 xxx"就等于给整面弹幕墙开了逐条查作者的接口。
router.delete(
  "/videos/:id/danmaku/:danmakuId",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 30, scope: "branch:danmakuDelete" }),
  removeDanmaku
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
