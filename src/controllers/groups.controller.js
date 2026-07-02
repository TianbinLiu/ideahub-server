const crypto = require("crypto");
const Group = require("../models/Group");
const GroupInvite = require("../models/GroupInvite");
const GroupJoinReferral = require("../models/GroupJoinReferral");
const GroupChat = require("../models/GroupChat");
const User = require("../models/User");
const Follow = require("../models/Follow");
const AppError = require("../utils/AppError");
const {
  WORLD_GROUP_SLUG,
  buildWorldGroupPayload,
  getUserJoinedGroupSlugs,
  isGroupManager,
  normalizeGroupVisibility,
  normalizeGroupSlug,
} = require("../utils/groups");

function makeCode(bytes = 5) {
  return crypto.randomBytes(bytes).toString("hex");
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isJoined(group, user) {
  if (!group || !user) return false;
  return getUserJoinedGroupSlugs(user).includes(group.slug);
}

function serializeGroup(group, user, options = {}) {
  const plain = typeof group.toObject === "function" ? group.toObject() : group;
  const visibility = normalizeGroupVisibility(plain.visibility, "private");
  const canManage = isGroupManager(plain, user);
  const joined = plain.slug === WORLD_GROUP_SLUG || isJoined(plain, user) || canManage;
  const canCreateInvite = Boolean(user && joined && (visibility !== "unlisted" || canManage));
  const result = {
    ...plain,
    visibility,
    joined,
    isWorld: false,
    canManage,
    canCreateInvite,
  };

  if (!options.includeSecrets || !canManage) {
    delete result.joinCode;
  }

  return result;
}

async function getGroupOrThrow(slug, selectSecrets = false) {
  const query = Group.findOne({ slug: normalizeGroupSlug(slug) });
  if (selectSecrets) query.select("+joinCode");
  const group = await query;
  if (!group) {
    throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
  }
  return group;
}

function ensureGroupVisible(group, user) {
  if (group.visibility !== "unlisted") return;
  if (isJoined(group, user) || isGroupManager(group, user)) return;
  throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
}

async function followEachOther(userA, userB) {
  if (!userA || !userB || String(userA) === String(userB)) return;
  await Promise.all([
    Follow.updateOne({ follower: userA, following: userB }, { $setOnInsert: { follower: userA, following: userB } }, { upsert: true }),
    Follow.updateOne({ follower: userB, following: userA }, { $setOnInsert: { follower: userB, following: userA } }, { upsert: true }),
  ]);
}

async function listGroups(req, res, next) {
  try {
    const q = String(req.query.q || "").trim();
    const filter = q
      ? {
          $or: [
            { name: new RegExp(escapeRegex(q), "i") },
            { slug: new RegExp(escapeRegex(q), "i") },
            { description: new RegExp(escapeRegex(q), "i") },
          ],
        }
      : {};
    const rows = await Group.find(filter).sort({ memberCount: -1, createdAt: -1 }).select("name slug description visibility memberCount creator adminIds createdAt").lean();
    const joinedSlugs = new Set(getUserJoinedGroupSlugs(req.user));
    const visibleRows = rows.filter((item) => {
      const joined = joinedSlugs.has(item.slug);
      const canManage = isGroupManager(item, req.user);
      const visibility = normalizeGroupVisibility(item.visibility, "private");
      if (visibility === "unlisted") return joined || canManage;
      if (q) return true;
      return visibility === "public" || joined || canManage;
    });
    const groups = [
      buildWorldGroupPayload(true),
      ...visibleRows.map((item) => serializeGroup(item, req.user)),
    ];

    res.json({ ok: true, groups, joinedGroupSlugs: [WORLD_GROUP_SLUG, ...joinedSlugs] });
  } catch (err) {
    next(err);
  }
}

async function createGroup(req, res, next) {
  try {
    const name = String(req.body?.name || "").trim();
    const slug = normalizeGroupSlug(req.body?.slug || name);
    const description = String(req.body?.description || "").trim();
    const visibility = normalizeGroupVisibility(req.body?.visibility);
    const joinCode = String(req.body?.joinCode || "").trim() || (visibility === "public" ? "" : makeCode(4));

    if (!name) {
      throw new AppError("Group name is required", 400, "GROUP_NAME_REQUIRED");
    }

    if (!slug || slug === WORLD_GROUP_SLUG) {
      throw new AppError("Invalid group slug", 400, "INVALID_GROUP_SLUG");
    }

    const existing = await Group.findOne({ slug }).select("_id").lean();
    if (existing) {
      throw new AppError("Group already exists", 409, "GROUP_ALREADY_EXISTS");
    }

    const group = await Group.create({
      name,
      slug,
      description,
      visibility,
      creator: req.user._id,
      adminIds: [],
      joinCode,
      memberCount: 1,
    });

    await User.updateOne(
      { _id: req.user._id },
      { $addToSet: { joinedGroupSlugs: slug } }
    );

    res.status(201).json({ ok: true, group: { ...serializeGroup(group, req.user, { includeSecrets: true }), joined: true } });
  } catch (err) {
    next(err);
  }
}

async function joinGroup(req, res, next) {
  try {
    const slug = normalizeGroupSlug(req.params.slug);
    if (slug === WORLD_GROUP_SLUG) {
      return res.json({ ok: true, joined: true, slug });
    }

    const group = await getGroupOrThrow(slug, true);
    const body = req.body || {};
    const suppliedGroupCode = String(body.code || req.query.code || "").trim();
    const suppliedInviteCode = String(body.inviteCode || req.query.inviteCode || "").trim();
    const suppliedInviteToken = String(body.inviteToken || req.query.inviteToken || "").trim();
    let invite = null;

    if (suppliedInviteToken || suppliedInviteCode) {
      invite = await GroupInvite.findOne({
        groupSlug: slug,
        active: true,
        ...(suppliedInviteToken ? { token: suppliedInviteToken } : { code: suppliedInviteCode }),
      }).lean();
      if (!invite) {
        throw new AppError("Invalid invite", 403, "INVALID_GROUP_INVITE");
      }
    }

    const groupCodeMatches = Boolean(suppliedGroupCode && group.joinCode && suppliedGroupCode === group.joinCode);
    if (group.visibility !== "public" && group.joinCode && !groupCodeMatches && !invite) {
      throw new AppError("This group requires a code or invite link", 403, "GROUP_INVITE_REQUIRED");
    }

    const result = await User.updateOne(
      { _id: req.user._id, joinedGroupSlugs: { $ne: slug } },
      { $addToSet: { joinedGroupSlugs: slug } }
    );

    if (result.modifiedCount > 0) {
      await Group.updateOne({ _id: group._id }, { $inc: { memberCount: 1 } });
    }

    if (invite && String(invite.owner) !== String(req.user._id)) {
      await Promise.all([
        followEachOther(req.user._id, invite.owner),
        GroupJoinReferral.updateOne(
          { groupSlug: slug, invitee: req.user._id },
          { $setOnInsert: { groupSlug: slug, invitee: req.user._id, referrer: invite.owner, invite: invite._id, joinMethod: "invite" } },
          { upsert: true }
        ),
      ]);
    }

    res.json({ ok: true, joined: true, slug });
  } catch (err) {
    next(err);
  }
}

async function leaveGroup(req, res, next) {
  try {
    const slug = normalizeGroupSlug(req.params.slug);
    if (slug === WORLD_GROUP_SLUG) {
      throw new AppError("Cannot leave world group", 400, "WORLD_GROUP_REQUIRED");
    }

    const group = await getGroupOrThrow(slug);
    if (String(group.creator) === String(req.user._id)) {
      throw new AppError("Group creator cannot leave the group", 400, "GROUP_CREATOR_CANNOT_LEAVE");
    }

    const result = await User.updateOne(
      { _id: req.user._id, joinedGroupSlugs: slug },
      { $pull: { joinedGroupSlugs: slug } }
    );

    if (result.modifiedCount > 0) {
      await Promise.all([
        Group.updateOne({ _id: group._id }, { $inc: { memberCount: -1 }, $pull: { adminIds: req.user._id } }),
        GroupJoinReferral.deleteOne({ groupSlug: slug, invitee: req.user._id }),
      ]);
    }

    res.json({ ok: true, joined: false, slug });
  } catch (err) {
    next(err);
  }
}

async function getGroup(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug, true);
    ensureGroupVisible(group, req.user);
    res.json({ ok: true, group: serializeGroup(group, req.user, { includeSecrets: true }) });
  } catch (err) {
    next(err);
  }
}

async function createInvite(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    const joined = isJoined(group, req.user);
    const canManage = isGroupManager(group, req.user);
    if (!joined && !canManage) {
      throw new AppError("Join the group before creating an invite", 403, "GROUP_ACCESS_DENIED");
    }
    if (group.visibility === "unlisted" && !canManage) {
      throw new AppError("Only group managers can invite users to unlisted groups", 403, "GROUP_INVITE_MANAGER_ONLY");
    }

    const invite = await GroupInvite.create({
      groupSlug: group.slug,
      owner: req.user._id,
      code: makeCode(4),
      token: makeCode(18),
    });

    res.status(201).json({
      ok: true,
      invite: {
        _id: invite._id,
        groupSlug: invite.groupSlug,
        code: invite.code,
        token: invite.token,
        sharePath: `/groups/${group.slug}?joinToken=${invite.token}`,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function listGroupChats(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    ensureGroupVisible(group, req.user);
    const canRead = group.visibility === "public" || isJoined(group, req.user) || isGroupManager(group, req.user);
    if (!canRead) {
      throw new AppError("Group access denied", 403, "GROUP_ACCESS_DENIED");
    }

    const q = String(req.query.q || "").trim();
    const filter = { groupSlug: group.slug };
    if (q) {
      filter.$or = [
        { name: new RegExp(escapeRegex(q), "i") },
        { description: new RegExp(escapeRegex(q), "i") },
      ];
    }

    const chats = await GroupChat.find(filter)
      .sort({ memberCount: -1, createdAt: -1 })
      .populate("creator", "_id username role")
      .lean();

    res.json({ ok: true, chats });
  } catch (err) {
    next(err);
  }
}

async function createGroupChat(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    if (!isJoined(group, req.user) && !isGroupManager(group, req.user)) {
      throw new AppError("Join the group before creating a chat", 403, "GROUP_ACCESS_DENIED");
    }

    const chat = await GroupChat.create({
      groupSlug: group.slug,
      name: String(req.body?.name || "").trim(),
      description: String(req.body?.description || "").trim(),
      creator: req.user._id,
      memberCount: 1,
    });

    const populated = await GroupChat.findById(chat._id).populate("creator", "_id username role").lean();
    res.status(201).json({ ok: true, chat: populated });
  } catch (err) {
    next(err);
  }
}

async function listMembers(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    if (!isGroupManager(group, req.user)) {
      throw new AppError("Only group managers can view members", 403, "GROUP_MANAGER_REQUIRED");
    }

    const users = await User.find({ joinedGroupSlugs: group.slug })
      .select("_id username displayName avatarUrl role createdAt")
      .sort({ createdAt: 1 })
      .lean();
    const adminIds = new Set((group.adminIds || []).map(String));
    const members = users.map((user) => ({
      ...user,
      groupRole: String(group.creator) === String(user._id) ? "creator" : adminIds.has(String(user._id)) ? "admin" : "member",
    }));

    res.json({ ok: true, members, memberCount: group.memberCount });
  } catch (err) {
    next(err);
  }
}

async function updateMemberRole(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    if (String(group.creator) !== String(req.user._id) && req.user.role !== "admin") {
      throw new AppError("Only the group creator can manage admins", 403, "GROUP_CREATOR_REQUIRED");
    }

    const target = await User.findById(req.params.userId).select("_id joinedGroupSlugs").lean();
    if (!target || !getUserJoinedGroupSlugs(target).includes(group.slug)) {
      throw new AppError("Group member not found", 404, "GROUP_MEMBER_NOT_FOUND");
    }
    if (String(group.creator) === String(target._id)) {
      throw new AppError("Creator role cannot be changed", 400, "GROUP_CREATOR_ROLE_FIXED");
    }

    const update = req.body?.role === "admin"
      ? { $addToSet: { adminIds: target._id } }
      : { $pull: { adminIds: target._id } };
    await Group.updateOne({ _id: group._id }, update);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function removeMember(req, res, next) {
  try {
    const group = await getGroupOrThrow(req.params.slug);
    const canManage = isGroupManager(group, req.user);
    if (!canManage) {
      throw new AppError("Only group managers can remove members", 403, "GROUP_MANAGER_REQUIRED");
    }

    const targetId = req.params.userId;
    if (String(group.creator) === String(targetId)) {
      throw new AppError("Cannot remove group creator", 400, "GROUP_CREATOR_REQUIRED");
    }
    const targetIsAdmin = (group.adminIds || []).some((id) => String(id) === String(targetId));
    if (targetIsAdmin && String(group.creator) !== String(req.user._id) && req.user.role !== "admin") {
      throw new AppError("Only the group creator can remove admins", 403, "GROUP_CREATOR_REQUIRED");
    }

    const result = await User.updateOne(
      { _id: targetId, joinedGroupSlugs: group.slug },
      { $pull: { joinedGroupSlugs: group.slug } }
    );
    if (result.modifiedCount > 0) {
      await Promise.all([
        Group.updateOne({ _id: group._id }, { $inc: { memberCount: -1 }, $pull: { adminIds: targetId } }),
        GroupJoinReferral.deleteOne({ groupSlug: group.slug, invitee: targetId }),
      ]);
    }

    res.json({ ok: true, removed: result.modifiedCount > 0 });
  } catch (err) {
    next(err);
  }
}

module.exports = {
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
};