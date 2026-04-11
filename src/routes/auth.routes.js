const router = require("express").Router();
const { register, login, me, setPassword, changePassword, logoutAllSessions, getAuthCapabilities } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth");

router.post("/register", register);
router.post("/login", login);
router.get("/me", requireAuth, me);
router.post("/set-password", requireAuth, setPassword);
router.post("/change-password", requireAuth, changePassword);
router.post("/logout-all", requireAuth, logoutAllSessions);
router.get("/capabilities", getAuthCapabilities);

module.exports = router;
