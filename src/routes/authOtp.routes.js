//authOtp.routes.js

const router = require("express").Router();
const ctrl = require("../controllers/authOtp.controller");
const { rateLimit } = require("../middleware/rateLimit");

// Apply light IP rate-limit to OTP start endpoints to prevent abuse (max 10 req/min by default)
router.post("/email/register/start", rateLimit({ windowMs: 60 * 1000, max: 10 }), ctrl.emailRegisterStart);
router.post("/email/register/verify", ctrl.emailRegisterVerify);
router.post("/email/reset/start", rateLimit({ windowMs: 60 * 1000, max: 10 }), ctrl.emailResetStart);
router.post("/email/reset/verify", ctrl.emailResetVerify);

// 手机号 + 短信验证码登录（登录即注册）。start 会真发短信/扣费，限流更紧一点；
// verify 也限流，叠在 OTP 自身的 maxAttempts 之上再防一层暴力猜码。
router.post("/phone/login/start", rateLimit({ windowMs: 60 * 1000, max: 5 }), ctrl.phoneLoginStart);
router.post("/phone/login/verify", rateLimit({ windowMs: 60 * 1000, max: 20 }), ctrl.phoneLoginVerify);

module.exports = router;
