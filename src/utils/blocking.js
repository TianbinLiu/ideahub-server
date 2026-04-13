const mongoose = require("mongoose");
const Comment = require("../models/Comment");
const DmRequestBlock = require("../models/DmRequestBlock");
const AppError = require("./AppError");
const errorCodes = require("./errorCodes");

function toIdString(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function isValidObjectId(value) {
  const id = toIdString(value);
  return Boolean(id) && mongoose.isValidObjectId(id);
}

function sameUser(a, b) {
  const left = toIdString(a);
  const right = toIdString(b);
  return Boolean(left) && left === right;
}

async function hasAnyBlockBetween(userAId, userBId) {
  if (!isValidObjectId(userAId) || !isValidObjectId(userBId) || sameUser(userAId, userBId)) {
    return false;
  }

  const userA = toIdString(userAId);
  const userB = toIdString(userBId);
  const record = await DmRequestBlock.findOne({
    $or: [
      { blockerUserId: userA, blockedUserId: userB },
      { blockerUserId: userB, blockedUserId: userA },
    ],
  })
    .select("_id")
    .lean();

  return Boolean(record);
}

async function listBlockedUserIds(userId) {
  if (!isValidObjectId(userId)) {
    return new Set();
  }

  const currentUserId = toIdString(userId);
  const rows = await DmRequestBlock.find({
    $or: [{ blockerUserId: currentUserId }, { blockedUserId: currentUserId }],
  })
    .select("blockerUserId blockedUserId")
    .lean();

  const blockedUserIds = new Set();
  for (const row of rows) {
    const blockerUserId = toIdString(row.blockerUserId);
    const blockedUserId = toIdString(row.blockedUserId);
    const otherUserId = blockerUserId === currentUserId ? blockedUserId : blockerUserId;
    if (otherUserId && otherUserId !== currentUserId) {
      blockedUserIds.add(otherUserId);
    }
  }

  return blockedUserIds;
}

function filterItemsByBlockedUsers(items, blockedUserIds, getUserId) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const hiddenUserIds = blockedUserIds instanceof Set ? blockedUserIds : new Set(blockedUserIds || []);
  if (hiddenUserIds.size === 0) {
    return items.filter(Boolean);
  }

  return items.filter((item) => {
    if (!item) return false;
    const userId = toIdString(getUserId(item));
    return !userId || !hiddenUserIds.has(userId);
  });
}

async function ensureUsersVisibleOrThrow(viewerUserId, targetUserId, options = {}) {
  if (!isValidObjectId(viewerUserId) || !isValidObjectId(targetUserId) || sameUser(viewerUserId, targetUserId)) {
    return;
  }

  const blocked = await hasAnyBlockBetween(viewerUserId, targetUserId);
  if (!blocked) {
    return;
  }

  throw new AppError({
    status: options.status || 404,
    code: options.code || errorCodes.NOT_FOUND,
    message: options.message || "User not found",
  });
}

async function ensureNoBlockForInteraction(actorUserId, targetUserId, message = "Blocked users cannot interact.") {
  if (!isValidObjectId(actorUserId) || !isValidObjectId(targetUserId) || sameUser(actorUserId, targetUserId)) {
    return;
  }

  const blocked = await hasAnyBlockBetween(actorUserId, targetUserId);
  if (!blocked) {
    return;
  }

  throw new AppError({
    status: 403,
    code: errorCodes.FORBIDDEN,
    message,
  });
}

async function hasReplyToUser(authorUserId, targetUserId) {
  if (!isValidObjectId(authorUserId) || !isValidObjectId(targetUserId) || sameUser(authorUserId, targetUserId)) {
    return false;
  }

  const [row] = await Comment.aggregate([
    {
      $match: {
        author: new mongoose.Types.ObjectId(toIdString(authorUserId)),
        parentCommentId: { $ne: null },
      },
    },
    {
      $lookup: {
        from: "comments",
        localField: "parentCommentId",
        foreignField: "_id",
        as: "parentComment",
      },
    },
    { $unwind: "$parentComment" },
    {
      $match: {
        "parentComment.author": new mongoose.Types.ObjectId(toIdString(targetUserId)),
      },
    },
    { $limit: 1 },
    { $project: { _id: 1 } },
  ]);

  return Boolean(row);
}

async function assertCanCreateBlock(blockerUserId, targetUserId) {
  const blockerHasRepliedToTarget = await hasReplyToUser(blockerUserId, targetUserId);
  if (!blockerHasRepliedToTarget) {
    return;
  }

  const targetHasRepliedBack = await hasReplyToUser(targetUserId, blockerUserId);
  if (targetHasRepliedBack) {
    return;
  }

  throw new AppError({
    status: 403,
    code: errorCodes.FORBIDDEN,
    message: "You can only block this user after they have replied to you at least once.",
  });
}

module.exports = {
  assertCanCreateBlock,
  ensureNoBlockForInteraction,
  ensureUsersVisibleOrThrow,
  filterItemsByBlockedUsers,
  hasAnyBlockBetween,
  listBlockedUserIds,
  toIdString,
};