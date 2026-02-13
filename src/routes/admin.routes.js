const router = require("express").Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const ctrl = require("../controllers/admin.controller");

router.use(requireAuth, requireRole("admin"));

router.delete("/ideas/:id", ctrl.adminDeleteIdea);
router.delete("/users/:id", ctrl.adminDeleteUser);

module.exports = router;
