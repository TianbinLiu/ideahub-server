/**
 * @file messages.routes.js - 私信相关路由
 * @category Routes
 * @description 处理消息请求、私信对话等API端点
 * 
 * 路由:
 * POST   /api/messages/request              - 发起私信请求
 * GET    /api/messages/request              - 获取收到的请求
 * PATCH  /api/messages/request/:id/view     - 标记请求为已查看
 * PATCH  /api/messages/request/:id/accept   - 接受请求
 * PATCH  /api/messages/request/:id/reject   - 拒绝请求
 * GET    /api/messages/conversations        - 获取对话列表
 * GET    /api/messages/conversations/:id    - 获取对话的消息
 * POST   /api/messages/send                 - 发送消息
 */

const router = require("express").Router();
const {
  sendMessageRequest,
  listMessageRequests,
  viewMessageRequest,
  acceptMessageRequest,
  rejectMessageRequest,
  listConversations,
  getConversationMessages,
  sendDirectMessage,
  deleteConversation,
  blockDmUser,
  unblockDmUser,
  listDmBlacklist,
  getDmBlockStatus,
} = require("../controllers/messages.controller");
const { requireAuth } = require("../middleware/auth");

// 所有消息路由需要认证
router.use(requireAuth);

// 消息请求相关
router.post("/request", sendMessageRequest);
router.get("/request", listMessageRequests);
router.patch("/request/:requestId/view", viewMessageRequest);
router.patch("/request/:requestId/accept", acceptMessageRequest);
router.patch("/request/:requestId/reject", rejectMessageRequest);

// 对话和消息相关
router.get("/conversations", listConversations);
router.get("/conversations/:conversationId", getConversationMessages);
router.delete("/conversations/:conversationId", deleteConversation);
router.post("/send", sendDirectMessage);

// 私信黑名单
router.get("/blacklist", listDmBlacklist);
router.get("/blacklist/:userId/status", getDmBlockStatus);
router.post("/blacklist/:userId", blockDmUser);
router.delete("/blacklist/:userId", unblockDmUser);

module.exports = router;
