//authOtp.routes.js

const router = require("express").Router();
const ctrl = require("../controllers/authOtp.controller");
const { rateLimit } = require("../middleware/rateLimit");

// Apply light IP rate-limit to OTP start endpoints to prevent abuse (max 10 req/min by default)
router.post("/email/register/start", rateLimit({ windowMs: 60 * 1000, max: 10 }), ctrl.emailRegisterStart);
router.post("/email/register/verify", ctrl.emailRegisterVerify);
router.post("/email/reset/start", rateLimit({ windowMs: 60 * 1000, max: 10 }), ctrl.emailResetStart);
router.post("/email/reset/verify", ctrl.emailResetVerify);

module.exports = router;
