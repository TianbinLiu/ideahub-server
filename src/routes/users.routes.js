const router = require("express").Router();
const { 
  searchUsers, 
  getUserProfile, 
  toggleFollow, 
  getFollowers, 
  getFollowing,
  getUserBookmarks,
  getUserIdeas,
  getUserLeaderboards,
  getUserGroupReferrals,
  deleteAccount,
} = require("../controllers/users.controller");
const { voteUser, getUserReputation } = require("../controllers/reputation.controller");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");

// GET /api/users/search?q=username&limit=8
//
// ★★ 这条**必须**限流，它是本仓最贵的一个匿名端点：
//   查询是不锚定 + 大小写不敏感的正则，`i` 标志让任何索引都用不上（MongoDB 对
//   非 simple collation 的索引也不支持 $regex），所以"搜不到东西"的那一次
//   就是一次完整的 users 全表扫。而调用方是**每次敲键盘**都打的（app 里 250ms/300ms 防抖），
//   一个不登录的循环就能把 mongod 的 CPU 顶满。
//
// ★ 为什么按【IP】而不是按账号：这条挂的是 optionalAuth，游客也要能用。
//   userRateLimit 的 keyFor 对没登录的请求返回 null，而 rateLimit 遇到 null 会
//   **直接放行**（见 rateLimit.js 的警告）—— 也就是说按账号限等于对攻击者完全不限，
//   他只要不带 token。IP 是这里唯一一个对所有调用方都存在的维度。
//   代价是 CGNAT / 校园网 / 办公室出口共用一个桶，所以额度要**松**：
//   120/分钟 = 2 次/秒，比防抖后的真人手速（一次搜索大约 3~5 个请求）高一个量级，
//   却把"无上限的全表扫"压成了每个出口 2 次/秒。
//   （这一条与 loginRateLimit 的取舍同源：按 IP 的那道只用来削掉最粗暴的单机洪水。）
router.get(
  "/search",
  optionalAuth,
  rateLimit({ windowMs: 60 * 1000, max: 120, scope: "users:search" }),
  searchUsers
);

// GET /api/users/:id - Get user profile (public)
router.get("/:id", optionalAuth, getUserProfile);

// POST /api/users/:id/follow - Follow/unfollow user
router.post("/:id/follow", requireAuth, toggleFollow);

// GET /api/users/:id/followers - Get user's followers
router.get("/:id/followers", optionalAuth, getFollowers);

// GET /api/users/:id/following - Get users that user follows
router.get("/:id/following", optionalAuth, getFollowing);

// GET /api/users/:id/bookmarks - Get user's bookmarks
router.get("/:id/bookmarks", optionalAuth, getUserBookmarks);

// GET /api/users/:id/ideas - Get user's visible ideas/dynamics
router.get("/:id/ideas", optionalAuth, getUserIdeas);

// GET /api/users/:id/leaderboards - Get user's leaderboards
router.get("/:id/leaderboards", optionalAuth, getUserLeaderboards);

// GET /api/users/:id/group-referrals - Private invite/referral records
router.get("/:id/group-referrals", requireAuth, getUserGroupReferrals);

// POST /api/users/:id/reputation - Vote for user (like/dislike)
router.post("/:userId/reputation", requireAuth, voteUser);

// GET /api/users/:id/reputation - Get user's reputation stats
router.get("/:userId/reputation", optionalAuth, getUserReputation);

// DELETE /api/users/:id - Delete own account (irreversible)
router.delete("/:id", requireAuth, deleteAccount);

module.exports = router;
