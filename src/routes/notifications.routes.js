const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/notifications.controller");

router.get("/", requireAuth, ctrl.listMyNotifications);
router.get("/unread-count", requireAuth, ctrl.getUnreadCount);
router.post("/:id/read", requireAuth, ctrl.markOneRead);
router.post("/read-all", requireAuth, ctrl.markAllRead);

module.exports = router;
