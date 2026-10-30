//admin.routes.js

const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

// 全部 admin API 都需要：登录 + admin
router.use(requireAuth, requireRole("admin"));

// 获取项目架构文档
router.get("/docs", ctrl.adminGetProjectDocs);

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

/**
 * 免除某个用户的退款欠额（§15.4 R-13）。
 * ★ 存在的理由：欠额是自动产生的（渠道退款 - 当时余额），而退款的成因可能是
 *   我们自己的错（发重了、慢卡扣了两次）。没有这条口子，唯一的解法是去库里手改
 *   —— 那既不留痕，又绕过了账本。
 * ★ 免除会落一条 `debt_forgiven`（delta=0、金额记 costTokens），余额不动。
 */
router.post("/users/:id/forgive-debt", async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ ok: false, message: "user not found" });
    const wallet = require("../services/tokenWallet.service");
    const w = await wallet.forgiveDebt(req.params.id, `管理员 ${req.user.username || req.user._id} 免除`);
    if (!w) return res.status(404).json({ ok: false, message: "user not found" });
    res.json({ ok: true, wallet: w });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
