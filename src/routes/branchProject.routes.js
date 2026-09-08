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

// 取回一份画布（回炉时用）。
// @endpoint GET /api/branch/projects/by-video/:videoId
//   → { ok, project: { video, title, canvas, videoRevision, stale, lostCount, updatedAt } }
// ★★ `videoRevision` 是「这份画布描述的是作品第几版」，客户端**必须**拿它与作品当下的
//   `revision` 比：对不上就不许铺进工坊（那份画布是上一版的，就着它提交会把线上内容
//   静默退回）。`stale` 是同一件事的 UI 提示位，不作为拒绝依据。
router.get("/projects/by-video/:videoId", requireAuth, getProject);

// 留存 / 覆盖。
// @endpoint PUT /api/branch/projects/by-video/:videoId
//   body { title?, canvas, videoRevision, lostCount? }
//   ★★ `videoRevision` **必须等于作品当下的 revision**，对不上 400 PROJECT_REVISION_MISMATCH
//     （带 details.currentRevision）——这一格只能靠这条路往前走，回炉那边只标 stale。
// ★ 必须限流：每次都要序列化并落一份最大 2MB 的文档，
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
