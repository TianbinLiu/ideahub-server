/**
 * @file messages.controller.js - 私信和消息请求控制器
 * @category Controller
 * @description 处理私信请求、消息发送、对话管理等
 */

const MessageRequest = require("../models/MessageRequest");
const DirectMessage = require("../models/DirectMessage");
const User = require("../models/User");
const AppError = require("../utils/AppError");

/**
 * 生成对话ID（两个userId排序后的组合）
 */
function generateConversationId(userId1, userId2) {
  const ids = [userId1.toString(), userId2.toString()].sort();
  return ids.join(":");
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
    const { toUserId, initialMessage } = req.body;

    // 验证
    if (!toUserId || !initialMessage) {
      throw new AppError("Missing required fields: toUserId and initialMessage", 400);
    }

    if (initialMessage.trim().length === 0) {
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

    // 如果已有请求，则替换（upsert）
    let request = await MessageRequest.findOneAndUpdate(
      { fromUserId, toUserId },
      {
        initialMessage,
        status: "pending",
        viewedAt: null,
        respondedAt: null,
      },
      { upsert: true, new: true }
    )
      .populate("fromUserId", "username displayName avatarUrl")
      .populate("toUserId", "username displayName");

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
    const toUserId = req.user._id;
    const { status } = req.query;

    const filter = { toUserId };
    if (status) filter.status = status;

    const requests = await MessageRequest.find(filter)
      .populate("fromUserId", "username displayName avatarUrl role")
      .sort({ createdAt: -1 });

    res.json({ ok: true, requests });
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

    // 更新请求状态
    request.status = "accepted";
    request.respondedAt = new Date();
    await request.save();

    // 生成对话ID
    const conversationId = generateConversationId(request.fromUserId, toUserId);

    // 创建初始消息（发送者发起的隐藏消息现在可见）
    await DirectMessage.create({
      conversationId,
      participants: [request.fromUserId, toUserId],
      fromUserId: request.fromUserId,
      toUserId,
      content: request.initialMessage,
    });

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
    const toUserId = req.user._id;

    const request = await MessageRequest.findOne({ _id: requestId, toUserId });
    if (!request) {
      throw new AppError("Message request not found", 404);
    }

    request.status = "rejected";
    request.respondedAt = new Date();
    await request.save();

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
      { $match: { participants: userId } },
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

    // 填充用户信息
    const result = [];
    for (const conv of conversations) {
      const msg = conv.lastMessage;
      const otherUserId = msg.fromUserId.equals(userId) ? msg.toUserId : msg.fromUserId;
      
      const otherUser = await User.findById(otherUserId).select("username displayName avatarUrl role");
      
      result.push({
        conversationId: conv._id,
        otherUser,
        lastMessage: {
          content: msg.content,
          fromUser: msg.fromUserId.equals(userId) ? "me" : "them",
          createdAt: msg.createdAt,
        },
        unreadCount: conv.unreadCount,
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
      DirectMessage.find({ conversationId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("fromUserId", "username displayName avatarUrl role")
        .lean(),
      DirectMessage.countDocuments({ conversationId }),
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
    const { conversationId, toUserId, content } = req.body;

    // 验证
    if (!conversationId || !toUserId || !content || content.trim().length === 0) {
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

module.exports = {
  sendMessageRequest,
  listMessageRequests,
  viewMessageRequest,
  acceptMessageRequest,
  rejectMessageRequest,
  listConversations,
  getConversationMessages,
  sendDirectMessage,
};
