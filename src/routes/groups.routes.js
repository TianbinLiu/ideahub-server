const router = require("express").Router();
const { optionalAuth, requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createGroupBody } = require("../schemas/group.schemas");
const { listGroups, createGroup, joinGroup, leaveGroup } = require("../controllers/groups.controller");

router.get("/", optionalAuth, listGroups);
router.post("/", requireAuth, validate({ body: createGroupBody }), createGroup);
router.post("/:slug/join", requireAuth, joinGroup);
router.post("/:slug/leave", requireAuth, leaveGroup);

module.exports = router;