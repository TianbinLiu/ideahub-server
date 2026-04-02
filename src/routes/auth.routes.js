const router = require("express").Router();
const { register, login, me, getAuthCapabilities } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth");

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, me);
router.get("/capabilities", getAuthCapabilities);

module.exports = router;
