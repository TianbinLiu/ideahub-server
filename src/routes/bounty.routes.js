// src/routes/bounty.routes.js
// 赏金猎人（Bounty Hunter）路由，base /api/bounties，成功恒 {ok:true,...}。
// 注意：/mine 必须放在 /:id 之前，否则会被 :id 捕获。
const router = require("express").Router();
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const {
  createBody,
  updateBody,
  statusBody,
  submitBody,
  reviewBody,
  commentBody,
} = require("../schemas/bounty.schemas");
const {
  listBounties,
  listMyBounties,
  getBountyDetail,
  createBounty,
  updateBounty,
  removeBounty,
  setBountyStatus,
  listSubmissions,
  submitBounty,
  reviewSubmission,
  listComments,
  addComment,
} = require("../controllers/bounty.controller");

router.get("/", optionalAuth, listBounties);
router.get("/mine", requireAuth, listMyBounties);
router.post("/", requireAuth, validate({ body: createBody }), createBounty);
router.get("/:id", optionalAuth, getBountyDetail);
router.put("/:id", requireAuth, validate({ body: updateBody }), updateBounty);
router.delete("/:id", requireAuth, removeBounty);
router.post("/:id/status", requireAuth, validate({ body: statusBody }), setBountyStatus);
router.get("/:id/submissions", requireAuth, listSubmissions);
router.post("/:id/submissions", requireAuth, validate({ body: submitBody }), submitBounty);
router.post("/:id/submissions/:sid/review", requireAuth, validate({ body: reviewBody }), reviewSubmission);
router.get("/:id/comments", optionalAuth, listComments);
router.post("/:id/comments", requireAuth, validate({ body: commentBody }), addComment);

module.exports = router;
