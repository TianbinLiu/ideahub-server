//admin.routes.js

const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

// 全部 admin API 都需要：登录 + admin
router.use(requireAuth, requireRole("admin"));

// 列出用户（支持搜索）
router.get("/users", ctrl.adminListUsers);

// 列出 ideas（支持搜索）
router.get("/ideas", ctrl.adminListIdeas);

// 列出 leaderboards（支持搜索）
router.get("/leaderboards", ctrl.adminListLeaderboards);

// 列出 feedback ideas（支持 type 和 status 过滤）
router.get("/feedback", ctrl.adminListFeedback);

// 更新 feedback status
router.patch("/ideas/:id/feedback-status", ctrl.adminUpdateFeedbackStatus);

// 强制删除任意 Idea（含清理互动数据）
router.delete("/ideas/:id", ctrl.adminDeleteIdea);

// 强制删除任意 Leaderboard（含清理关联数据）
router.delete("/leaderboards/:id", ctrl.adminDeleteLeaderboard);

// 删除任意用户（含清理该用户所有数据）
router.delete("/users/:id", ctrl.adminDeleteUser);

module.exports = router;
