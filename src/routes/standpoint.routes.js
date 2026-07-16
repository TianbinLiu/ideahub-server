// src/routes/standpoint.routes.js
// 立场展开（Standpoint / Stance-Unfold）路由，base /api/standpoint，全部 requireAuth。
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { configBody, statusBody, accountBody, simulateBody, ingestBody } = require("../schemas/standpoint.schemas");
const {
  getAgent,
  updateConfig,
  setStatus,
  addAccount,
  removeAccount,
  listEvents,
  simulateEvent,
  ingestEvent,
  regenerateReply,
  sendReply,
  dismissEvent,
} = require("../controllers/standpoint.controller");

router.get("/", requireAuth, getAgent);
router.put("/config", requireAuth, validate({ body: configBody }), updateConfig);
router.post("/status", requireAuth, validate({ body: statusBody }), setStatus);
router.post("/accounts", requireAuth, validate({ body: accountBody }), addAccount);
router.delete("/accounts/:accountId", requireAuth, removeAccount);
router.get("/events", requireAuth, listEvents);
router.post("/events/simulate", requireAuth, validate({ body: simulateBody }), simulateEvent);
router.post("/ingest", requireAuth, validate({ body: ingestBody }), ingestEvent);
router.post("/events/:id/regenerate", requireAuth, regenerateReply);
router.post("/events/:id/send", requireAuth, sendReply);
router.post("/events/:id/dismiss", requireAuth, dismissEvent);

module.exports = router;
