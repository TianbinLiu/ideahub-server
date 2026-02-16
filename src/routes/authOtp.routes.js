//authOtp.routes.js

const router = require("express").Router();
const ctrl = require("../controllers/authOtp.controller");

router.post("/email/register/start", ctrl.emailRegisterStart);
router.post("/email/register/verify", ctrl.emailRegisterVerify);
router.post("/email/reset/start", ctrl.emailResetStart);
router.post("/email/reset/verify", ctrl.emailResetVerify);

module.exports = router;
