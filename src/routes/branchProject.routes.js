// src/routes/branchProject.routes.js
// 已发布作品的「工坊工程」（画布快照），base /api/branch，路径全在 /projects 下，
// 与 /videos /cards /decks /templates /schemes /skills /compose 不重叠。
//
// ★ 四条全部 requireAuth；「只有作者能碰」的判定在 controller 一处（铁律六）。
// ★ 大 body（画布最大 2MB）走 app.js 里对整个 /api/branch 挂的 jsonGate，
//   这里不需要再挂一遍。
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate } = require("../middleware/validate");
const { projectBody } = require("../schemas/branchProject.schemas");
const {
  putProject,
  getProject,
  deleteProject,
  listProjects,
} = require("../controllers/branchProject.controller");

// 我留存了哪些工程（只回元信息，绝不回 canvas）
router.get("/projects", requireAuth, listProjects);

// 取回一份画布（回炉时用）
router.get("/projects/by-video/:videoId", requireAuth, getProject);

// 留存 / 覆盖。★ 必须限流：每次都要序列化并落一份最大 2MB 的文档，
//   而"发布之后自动留存一次 + 用户手点重试"的正常频率远低于 12/分钟。
//   按【账号】计：这条在 requireAuth 后面，按 IP 计等于换个出口就重开一桶。
router.put(
  "/projects/by-video/:videoId",
  requireAuth,
  userRateLimit({ windowMs: 60 * 1000, max: 12, scope: "branch:project" }),
  validate({ body: projectBody }),
  putProject
);

// 用户主动放弃留存（作品本身不受影响）
router.delete("/projects/by-video/:videoId", requireAuth, deleteProject);

module.exports = router;
