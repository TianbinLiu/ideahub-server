//admin.routes.js

const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

// 全部 admin API 都需要：登录 + admin
router.use(requireAuth, requireRole("admin"));

// 列出用户（支持搜索）
router.get("/users", ctrl.adminListUsers);

// 强制删除任意 Idea（含清理互动数据）
router.delete("/ideas/:id", ctrl.adminDeleteIdea);

// 删除任意用户（含清理该用户所有数据）
router.delete("/users/:id", ctrl.adminDeleteUser);

module.exports = router;
