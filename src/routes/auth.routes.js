const router = require("express").Router();
const { register, login, me, setPassword, changePassword, logoutAllSessions, getAuthCapabilities } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth");
const { rateLimit, loginRateLimit } = require("../middleware/rateLimit");

// 登录/注册此前完全无节流 —— 撞库零成本，且 bcrypt(cost 10) 的每次校验都是
// 单线程 Node 上的 CPU 密集操作，爆破同时构成 CPU 放大 DoS（打的是自己的服务）。
// loginRateLimit 同时按 IP 与按账号两个维度计数，见 middleware/rateLimit.js 的说明。
// 注册按 IP 限，同样要照顾 NAT 后的真实用户（默认 30/小时，可用 REGISTER_RATE_MAX 调）。
// 防批量注册的主力应该是邮箱/短信验证，限流只是粗粒度兜底。
router.post("/register", rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_MAX || 30),
  scope: "register",
}), register);
router.post("/login", ...loginRateLimit("emailOrUsername"), login);
router.get("/me", requireAuth, me);
router.post("/set-password", requireAuth, setPassword);
// 改密要求提供当前密码，同样是可爆破面（且已登录不代表知道原密码）
router.post("/change-password", requireAuth, rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: "change-password",
  keyFor: (req) => String(req.user?._id ?? ""),
}), changePassword);
router.post("/logout-all", requireAuth, logoutAllSessions);
router.get("/capabilities", getAuthCapabilities);

module.exports = router;
