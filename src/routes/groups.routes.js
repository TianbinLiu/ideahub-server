const router = require("express").Router();
const { optionalAuth, requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { createGroupBody, joinGroupBody, createGroupChatBody, updateGroupMemberBody } = require("../schemas/group.schemas");
const {
	listGroups,
	createGroup,
	joinGroup,
	leaveGroup,
	getGroup,
	createInvite,
	listGroupChats,
	createGroupChat,
	listMembers,
	updateMemberRole,
	removeMember,
} = require("../controllers/groups.controller");

router.get("/", optionalAuth, listGroups);
router.post("/", requireAuth, validate({ body: createGroupBody }), createGroup);
router.get("/:slug", optionalAuth, getGroup);
router.post("/:slug/join", requireAuth, validate({ body: joinGroupBody }), joinGroup);
router.post("/:slug/leave", requireAuth, leaveGroup);
router.post("/:slug/invites", requireAuth, createInvite);
router.get("/:slug/chats", optionalAuth, listGroupChats);
router.post("/:slug/chats", requireAuth, validate({ body: createGroupChatBody }), createGroupChat);
router.get("/:slug/members", requireAuth, listMembers);
router.patch("/:slug/members/:userId", requireAuth, validate({ body: updateGroupMemberBody }), updateMemberRole);
router.delete("/:slug/members/:userId", requireAuth, removeMember);

module.exports = router;