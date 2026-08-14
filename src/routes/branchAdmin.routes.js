// src/routes/branchAdmin.routes.js
// 分支视频的**管理端**路由，base /api/admin/branch。
//
// ★ 为什么单开一个文件而不是塞进 admin.routes.js：那个文件里现在全是 Idea /
//   Leaderboard / feedback 的东西，与 branch 这一摊没有任何共用代码；而 base 选在
//   `/api/admin/branch` 是**跟着举报那条线**走的 —— 它已经把管理端挂在
//   `/api/admin/branch/reports`（见 app.js）。后台控制台因此只有一个前缀要记，
//   不会出现"举报在 /api/admin/branch 下、统计却在 /api/branch/admin 下"这种
//   谁都会写错一次的分裂。
//
// ★ 门在这里统一开一次（requireAuth + requireRole("admin")），与 admin.routes.js
//   的写法一致。⚠ 别在下面每条路由上再挂一遍：多挂一次就是多一次 User.findById。
//
// ★ 处置类端点（下架 / 撤销）的实现在 controllers/branchVideo.controller.js，
//   与作者自己的那几条端点**共用同一份**下架写入与清理逻辑（applyTakedown /
//   purgeVideo）。这里只是给它们开了一扇需要管理员身份的门。
//
// ★ 硬删除**不在这里另开一条**：DELETE /api/branch/videos/:id 已经放行管理员了
//   （判据是 controller 的 assertCanDelete 一处）。同一件事开两条路径，
//   迟早有一条被改漏。
const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
// 角色名只有 utils/roles 一处（铁律六）
const { ADMIN_ROLE } = require("../utils/roles");
const {
  takedownVideo,
  revokeTakedown,
  listTakedowns,
  branchStats,
} = require("../controllers/branchVideo.controller");
// 用户管理与内容钻取（封禁/删号/发通知/三张后台列表）在自己的 controller 里，
// 复用件（清理、序列化、计数回写）仍然只有 branchVideo/branchAsset 那一份
const {
  listUsers,
  banUser,
  unbanUser,
  deleteUser,
  notifyUser,
  listVideosAdmin,
  listCommentsAdmin,
  listDanmakuAdmin,
} = require("../controllers/branchAdmin.controller");

router.use(requireAuth, requireRole(ADMIN_ROLE));

// 下架（可逆）/ 撤销下架。作者改不动这两样 —— 他手上那把开关叫 visibility，
// 而 visibility 是"仅自己可见"，不是"平台隐藏"（见 controller 的说明）。
router.post("/videos/:id/takedown", takedownVideo);
router.delete("/videos/:id/takedown", revokeTakedown);

// 当前被下架的作品。★ 没有这条，"撤销下架"就是个找不到入口的功能：
// 下完架之后那条作品从所有列表里消失，管理员手上只剩一个当时的 videoId。
router.get("/takedowns", listTakedowns);

// 平台数据（用户 / 封禁数 / 作品 / 下架 / 评论 / 弹幕 / 待处理举报）
router.get("/stats", branchStats);

// ── 用户管理 ────────────────────────────────────────────────────
// 列表：分页 + username/displayName 子串搜索 + role/封禁状态筛选。
// 回包 email/phone 一律打码（理由见 controller 的 maskEmail）。
router.get("/users", listUsers);
// 封禁（可逆对，与下架/撤销同构）。reason 必填；拒绝封禁管理员。
// 封禁挡的是登录与一切带 token 的请求，**不**自动隐藏内容（两权分开，见 User model）。
router.post("/users/:id/ban", banUser);
router.delete("/users/:id/ban", unbanUser);
// 硬删账号（级联，不可逆）。拒绝删管理员 —— 要删先降权，防手滑团灭。
router.delete("/users/:id", deleteUser);
// 给某个用户发一条平台通知（ADMIN_NOTICE，自由文本，不透操作人）
router.post("/users/:id/notify", notifyUser);

// ── 内容钻取（只读列表；删除走各内容自己的既有端点，不在这里另开）────
router.get("/videos", listVideosAdmin);
router.get("/comments", listCommentsAdmin);
router.get("/danmaku", listDanmakuAdmin);

// ★ 不额外限流：这几条只有管理员打得动，而管理员本来就能删库；再套一个桶
//   只会在处理一波刷屏举报时把自己卡住。
module.exports = router;
