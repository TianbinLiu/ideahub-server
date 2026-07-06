/**
 * @file messages.controller.js - 私信和消息请求控制器
 * @category Controller
 * @description 处理私信请求、消息发送、对话管理等
 */

const MessageRequest = require("../models/MessageRequest");
const DirectMessage = require("../models/DirectMessage");
const DmRequestBlock = require("../models/DmRequestBlock");
const User = require("../models/User");
const Follow = require("../models/Follow");
const AppError = require("../utils/AppError");
const { assertCanCreateBlock, hasAnyBlockBetween } = require("../utils/blocking");
const { createNotification } = require("../services/notification.service");

/**
 * 生成对话ID（两个userId排序后的组合）
 */
function generateConversationId(userId1, userId2) {
  const ids = [userId1.toString(), userId2.toString()].sort();
  return ids.join(":");
}

function trimMessage(input, max = 2000) {
  return String(input || "").trim().slice(0, max);
}

async function areMutualFollowers(userAId, userBId) {
  const [aFollowsB, bFollowsA] = await Promise.all([
    Follow.exists({ follower: userAId, following: userBId }),
    Follow.exists({ follower: userBId, following: userAId }),
  ]);
  return Boolean(aFollowsB && bFollowsA);
}

function getMessageRequestsBetween(userAId, userBId) {
  return MessageRequest.find({
    $or: [
      { fromUserId: userAId, toUserId: userBId },
      { fromUserId: userBId, toUserId: userAId },
    ],
  }).sort({ updatedAt: -1, createdAt: -1 });
}

function pickLatestRequest(requests) {
  return [...(requests || [])].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0] || null;
}

async function createDirectMessage({ fromUserId, toUserId, content }) {
  const conversationId = generateConversationId(fromUserId, toUserId);
  const message = await DirectMessage.create({
    conversationId,
    participants: [fromUserId, toUserId],
    fromUserId,
    toUserId,
    content: trimMessage(content),
  });
  await message.populate("fromUserId", "username displayName avatarUrl role");
  return { conversationId, message };
}

async function ensureInitialRequestMessage(request, conversationId) {
  const exists = await DirectMessage.exists({
    conversationId,
    fromUserId: request.fromUserId,
    toUserId: request.toUserId,
    content: request.initialMessage,
  });
  if (exists) return;

  await DirectMessage.create({
    conversationId,
    participants: [request.fromUserId, request.toUserId],
    fromUserId: request.fromUserId,
    toUserId: request.toUserId,
    content: request.initialMessage,
  });
}

async function canStartConversationDirectly(userAId, userBId) {
  const requests = await getMessageRequestsBetween(userAId, userBId).lean();
  return requests.some((request) => request.status === "accepted") || await areMutualFollowers(userAId, userBId);
}

/**
 * @api POST /api/messages/request
 * @desc 发起私信请求
 * @body { toUserId: ObjectId, initialMessage: string }
 * @returns { ok: true, request: {...} }
 */
async function sendMessageRequest(req, res, next) {
  try {
    const fromUserId = req.user._id;
    const { toUserId } = req.body;
    const initialMessage = trimMessage(req.body?.initialMessage, 500);

    // 验证
    if (!toUserId || !initialMessage) {
      throw new AppError("Missing required fields: toUserId and initialMessage", 400);
    }

    if (initialMessage.length === 0) {
      throw new AppError("Initial message cannot be empty", 400);
    }

    if (fromUserId.toString() === toUserId) {
      throw new AppError("Cannot send message request to yourself", 400);
    }

    // 检查目标用户是否存在
    const targetUser = await User.findById(toUserId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    // 检查是否被对方屏蔽私信申请
    const blockedByTarget = await DmRequestBlock.findOne({
      blockerUserId: toUserId,
      blockedUserId: fromUserId,
    }).lean();
    if (blockedByTarget) {
      throw new AppError("You cannot send message requests to this user", 403);
    }

    // 自己已将对方加入黑名单时，不允许继续发起私信申请
    const blockedBySelf = await DmRequestBlock.findOne({
      blockerUserId: fromUserId,
      blockedUserId: toUserId,
    }).lean();
    if (blockedBySelf) {
      throw new AppError("Please remove this user from blacklist before sending message request", 400);
    }

    if (await canStartConversationDirectly(fromUserId, toUserId)) {
      const { conversationId, message } = await createDirectMessage({ fromUserId, toUserId, content: initialMessage });
      return res.json({ ok: true, direct: true, conversationId, message });
    }

    const oppositePendingRequest = await MessageRequest.findOne({
      fromUserId: toUserId,
      toUserId: fromUserId,
      status: "pending",
    });

    if (oppositePendingRequest) {
      oppositePendingRequest.status = "accepted";
      oppositePendingRequest.respondedAt = new Date();
      await oppositePendingRequest.save();
      const conversationId = generateConversationId(fromUserId, toUserId);
      await ensureInitialRequestMessage(oppositePendingRequest, conversationId);
      const { message } = await createDirectMessage({ fromUserId, toUserId, content: initialMessage });
      return res.json({ ok: true, direct: true, conversationId, message, acceptedRequestId: oppositePendingRequest._id });
    }

    const existingRequest = await MessageRequest.findOne({ fromUserId, toUserId });

    if (existingRequest && existingRequest.status === "pending") {
      throw new AppError("You already have a pending message request to this user. Please wait for their response.", 400);
    }

    if (existingRequest && existingRequest.status === "accepted") {
      const { conversationId, message } = await createDirectMessage({ fromUserId, toUserId, content: initialMessage });
      return res.json({ ok: true, direct: true, conversationId, message });
    }

    // 如果存在已拒绝或已接受的申请，更新而不是创建新记录（避免唯一索引冲突）
    let request;
    if (existingRequest) {
      request = await MessageRequest.findOneAndUpdate(
        { fromUserId, toUserId },
        {
          initialMessage,
          status: "pending",
          viewedAt: null,
          respondedAt: null,
          responseMessage: null,
        },
        { new: true }
      );
      request = await request.populate("fromUserId", "username displayName avatarUrl");
      request = await request.populate("toUserId", "username displayName avatarUrl");
    } else {
      // 创建新请求
      request = await MessageRequest.create({
        fromUserId,
        toUserId,
        initialMessage,
        status: "pending",
      });
      request = await request.populate("fromUserId", "username displayName avatarUrl");
      request = await request.populate("toUserId", "username displayName avatarUrl");
    }

    res.json({ ok: true, request });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/messages/requests
 * @desc 获取收到的消息请求
 * @query status: 'pending' | 'accepted' | 'rejected' (optional)
 * @returns { ok: true, requests: [...] }
 */
async function listMessageRequests(req, res, next) {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    // 构建过滤条件
    let statusFilter = {};
    if (status) statusFilter.status = status;

    // 获取收到的申请
    const receivedRequests = await MessageRequest.find({
      toUserId: userId,
      ...statusFilter,
    })
      .populate("fromUserId", "username displayName avatarUrl role")
      .sort({ createdAt: -1 });

    // 获取发出的申请
    const sentRequests = await MessageRequest.find({
      fromUserId: userId,
      ...statusFilter,
    })
      .populate("toUserId", "username displayName avatarUrl role")
      .sort({ createdAt: -1 });

    res.json({
      ok: true,
      receivedRequests,
      sentRequests,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * @api PATCH /api/messages/request/:requestId/view
 * @desc 标记消息请求为已查看
 * @returns { ok: true }
 */
async function viewMessageRequest(req, res, next) {
  try {
    const { requestId } = req.params;
    const toUserId = req.user._id;

    const request = await MessageRequest.findOne({ _id: requestId, toUserId });
    if (!request) {
      throw new AppError("Message request not found", 404);
    }

    if (!request.viewedAt) {
      request.viewedAt = new Date();
      await request.save();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @api PATCH /api/messages/request/:requestId/accept
 * @desc 接受消息请求
 * @returns { ok: true, conversationId: string }
 */
async function acceptMessageRequest(req, res, next) {
  try {
    const { requestId } = req.params;
    const toUserId = req.user._id;

    const request = await MessageRequest.findOne({ _id: requestId, toUserId });
    if (!request) {
      throw new AppError("Message request not found", 404);
    }

    if (request.status === "accepted") {
      return res.json({ ok: true, conversationId: generateConversationId(request.fromUserId, toUserId) });
    }

    if (request.status !== "pending") {
      throw new AppError("Only pending message requests can be accepted", 400);
    }

    // 更新请求状态
    request.status = "accepted";
    request.respondedAt = new Date();
    await request.save();

    // 生成对话ID
    const conversationId = generateConversationId(request.fromUserId, toUserId);

    await ensureInitialRequestMessage(request, conversationId);

    // 向发起人发送通知
    try {
      await createNotification({
        userId: request.fromUserId,
        actorId: toUserId,
        type: "MESSAGE_REQUEST_ACCEPTED",
        payload: {
          requestId,
          conversationId,
          responderUsername: (await User.findById(toUserId).select("username")).username,
        },
      });
    } catch (notifErr) {
      console.error("[acceptMessageRequest] Failed to create notification:", notifErr);
      // 不因为通知失败而中断主逻辑
    }

    res.json({ ok: true, conversationId });
  } catch (err) {
    next(err);
  }
}

/**
 * @api PATCH /api/messages/request/:requestId/reject
 * @desc 拒绝消息请求
 * @returns { ok: true }
 */
async function rejectMessageRequest(req, res, next) {
  try {
    const { requestId } = req.params;
    const responseMessage = trimMessage(req.body?.responseMessage, 500);
    const toUserId = req.user._id;

    const request = await MessageRequest.findOne({ _id: requestId, toUserId });
    if (!request) {
      throw new AppError("Message request not found", 404);
    }

    if (request.status !== "pending") {
      throw new AppError("Only pending message requests can be rejected", 400);
    }

    request.status = "rejected";
    request.respondedAt = new Date();
    if (responseMessage) {
      request.responseMessage = responseMessage;
    }
    await request.save();

    // 向发起人发送通知
    try {
      await createNotification({
        userId: request.fromUserId,
        actorId: toUserId,
        type: "MESSAGE_REQUEST_REJECTED",
        payload: {
          requestId,
          responseMessage: request.responseMessage || null,
          responderUsername: (await User.findById(toUserId).select("username")).username,
        },
      });
    } catch (notifErr) {
      console.error("[rejectMessageRequest] Failed to create notification:", notifErr);
      // 不因为通知失败而中断主逻辑
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/messages/conversations
 * @desc 获取用户的所有对话列表（最后一条消息）
 * @returns { ok: true, conversations: [...] }
 */
async function listConversations(req, res, next) {
  try {
    const userId = req.user._id;

    // 获取所有包含当前用户的对话
    const conversations = await DirectMessage.aggregate([
      { $match: { participants: userId, deletedFor: { $ne: userId } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: { $cond: [{ $and: [{ $eq: ["$toUserId", userId] }, { $eq: ["$readAt", null] }] }, 1, 0] },
          },
        },
      },
      { $sort: { "lastMessage.createdAt": -1 } },
    ]);

    // 填充用户信息和申请状态
    const result = [];
    for (const conv of conversations) {
      const msg = conv.lastMessage;
      const otherUserId = msg.fromUserId.equals(userId) ? msg.toUserId : msg.fromUserId;
      
      const otherUser = await User.findById(otherUserId).select("username displayName avatarUrl role");
      const currentUser = await User.findById(userId).select("username displayName avatarUrl role");
      
      // 查找双方的私信申请记录
      const request = await MessageRequest.findOne({
        $or: [
          { fromUserId: userId, toUserId: otherUserId },
          { fromUserId: otherUserId, toUserId: userId },
        ],
      }).select("status fromUserId").lean();

      result.push({
        conversationId: conv._id,
        participants: [currentUser, otherUser].filter(Boolean),
        otherUser,
        lastMessage: {
          content: msg.content,
          fromUser: msg.fromUserId.equals(userId) ? "me" : "them",
          fromUserId: msg.fromUserId,
          toUserId: msg.toUserId,
          createdAt: msg.createdAt,
        },
        unreadCount: conv.unreadCount,
        requestStatus: request?.status || null,
        isRequestInitiator: request ? request.fromUserId.toString() === userId.toString() : false,
      });
    }

    res.json({ ok: true, conversations: result });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/messages/conversations/:conversationId
 * @desc 获取对话的消息历史
 * @query page: number, limit: number
 * @returns { ok: true, messages: [...], total: number }
 */
async function getConversationMessages(req, res, next) {
  try {
    const { conversationId } = req.params;
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "50", 10), 1), 100);

    // 验证用户是否在对话中
    const isMember = await DirectMessage.findOne({
      conversationId,
      participants: userId,
    });

    if (!isMember) {
      throw new AppError("Access denied", 403);
    }

    const [messages, total] = await Promise.all([
      DirectMessage.find({ conversationId, deletedFor: { $ne: userId } })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("fromUserId", "username displayName avatarUrl role")
        .lean(),
      DirectMessage.countDocuments({ conversationId, deletedFor: { $ne: userId } }),
    ]);

    // 标记为已读（当前用户接收的消息）
    await DirectMessage.updateMany(
      { conversationId, toUserId: userId, readAt: null },
      { readAt: new Date() }
    );

    res.json({ 
      ok: true, 
      messages: messages.reverse(), 
      total, 
      page, 
      limit 
    });
  } catch (err) {
    next(err);
  }
}

/**
 * @api POST /api/messages/send
 * @desc 发送私信消息
 * @body { conversationId: string, toUserId: ObjectId, content: string }
 * @returns { ok: true, message: {...} }
 */
async function sendDirectMessage(req, res, next) {
  try {
    const fromUserId = req.user._id;
    const { conversationId, toUserId } = req.body;
    const content = trimMessage(req.body?.content, 2000);

    // 验证
    if (!conversationId || !toUserId || !content || content.length === 0) {
      throw new AppError("Missing required fields", 400);
    }

    // 验证对话的参与者
    const expectedConvId = generateConversationId(fromUserId, toUserId);
    if (conversationId !== expectedConvId) {
      throw new AppError("Invalid conversation ID", 400);
    }

    // 验证目标用户是否真实
    const targetUser = await User.findById(toUserId);
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    if (await hasAnyBlockBetween(fromUserId, toUserId)) {
      throw new AppError("Blocked users cannot message each other", 403);
    }

    const requests = await getMessageRequestsBetween(fromUserId, toUserId);
    const mutualFollowers = await areMutualFollowers(fromUserId, toUserId);

    if (requests.length === 0 && !mutualFollowers) {
      throw new AppError("No message request found. Please send a message request first.", 403);
    }

    const latestRequest = pickLatestRequest(requests);

    // 根据最新申请的状态决定是否允许发送消息
    if (mutualFollowers || latestRequest?.status === "accepted") {
      // 最新申请已被接受，双方都可以发送消息
    } else if (latestRequest?.status === "pending") {
      // 如果当前用户是最新申请的发起人，不能发送（等待对方接受）
      if (latestRequest.fromUserId.toString() === fromUserId.toString()) {
        throw new AppError("Message request is still pending. Wait for acceptance.", 403);
      }
      latestRequest.status = "accepted";
      latestRequest.respondedAt = new Date();
      await latestRequest.save();
      await ensureInitialRequestMessage(latestRequest, conversationId);
    } else if (latestRequest?.status === "rejected") {
      // 最新申请被拒绝，任何人都不能发送消息
      // 需要发起新的申请来更新状态
      throw new AppError("Message request was rejected. Cannot send messages.", 403);
    }

    // 创建消息
    const message = await DirectMessage.create({
      conversationId,
      participants: [fromUserId, toUserId],
      fromUserId,
      toUserId,
      content,
    });

    await message.populate("fromUserId", "username displayName avatarUrl role");

    res.json({ ok: true, message });
  } catch (err) {
    next(err);
  }
}

/**
 * @api DELETE /api/messages/conversations/:conversationId
 * @desc 仅删除对话
 * @returns { ok: true }
 */
async function deleteConversation(req, res, next) {
  try {
    const { conversationId } = req.params;
    const userId = req.user._id;

    const anyMessage = await DirectMessage.findOne({ conversationId, participants: userId, deletedFor: { $ne: userId } }).lean();
    if (!anyMessage) {
      throw new AppError("Conversation not found", 404);
    }

    await DirectMessage.updateMany(
      { conversationId, participants: userId },
      { $addToSet: { deletedFor: userId } }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @api POST /api/messages/blacklist/:userId
 * @desc 拉黑用户私信申请
 * @returns { ok: true }
 */
async function blockDmUser(req, res, next) {
  try {
    const blockerUserId = req.user._id;
    const { userId } = req.params;

    if (!userId) {
      throw new AppError("Missing userId", 400);
    }
    if (blockerUserId.toString() === userId.toString()) {
      throw new AppError("Cannot blacklist yourself", 400);
    }

    const targetUser = await User.findById(userId).select("_id").lean();
    if (!targetUser) {
      throw new AppError("User not found", 404);
    }

    await assertCanCreateBlock(blockerUserId, userId);

    const sentPendingRequest = await MessageRequest.findOne({
      fromUserId: blockerUserId,
      toUserId: userId,
      status: "pending",
    }).lean();
    if (sentPendingRequest) {
      throw new AppError("You must wait for this user to respond to your message request before blacklisting them.", 403);
    }

    const sentMessage = await DirectMessage.exists({ fromUserId: blockerUserId, toUserId: userId });
    const receivedMessage = await DirectMessage.exists({ fromUserId: userId, toUserId: blockerUserId });
    if (sentMessage && !receivedMessage) {
      throw new AppError("You can only blacklist this user after they have had a chance to reply.", 403);
    }

    await DmRequestBlock.findOneAndUpdate(
      { blockerUserId, blockedUserId: userId },
      { $set: { blockerUserId, blockedUserId: userId } },
      { upsert: true, new: true }
    );

    await MessageRequest.updateMany(
      {
        fromUserId: userId,
        toUserId: blockerUserId,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          respondedAt: new Date(),
        },
      }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @api DELETE /api/messages/blacklist/:userId
 * @desc 取消拉黑用户私信申请
 * @returns { ok: true }
 */
async function unblockDmUser(req, res, next) {
  try {
    const blockerUserId = req.user._id;
    const { userId } = req.params;

    await DmRequestBlock.deleteOne({ blockerUserId, blockedUserId: userId });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/messages/blacklist
 * @desc 获取我的私信黑名单
 * @returns { ok: true, items: [...] }
 */
async function listDmBlacklist(req, res, next) {
  try {
    const blockerUserId = req.user._id;

    const items = await DmRequestBlock.find({ blockerUserId })
      .populate("blockedUserId", "username displayName avatarUrl role")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/messages/blacklist/:userId/status
 * @desc 获取我是否拉黑该用户
 * @returns { ok: true, blocked: boolean }
 */
async function getDmBlockStatus(req, res, next) {
  try {
    const blockerUserId = req.user._id;
    const { userId } = req.params;

    const item = await DmRequestBlock.findOne({ blockerUserId, blockedUserId: userId }).select("_id").lean();

    res.json({ ok: true, blocked: !!item });
  } catch (err) {
    next(err);
  }
}

module.exports = {
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
};
