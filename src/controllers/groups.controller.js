const Group = require("../models/Group");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const {
  WORLD_GROUP_SLUG,
  buildWorldGroupPayload,
  getUserJoinedGroupSlugs,
  normalizeGroupSlug,
} = require("../utils/groups");

async function listGroups(req, res, next) {
  try {
    const rows = await Group.find({}).sort({ memberCount: -1, createdAt: -1 }).select("name slug description memberCount creator createdAt").lean();
    const joinedSlugs = new Set(getUserJoinedGroupSlugs(req.user));
    const groups = [
      buildWorldGroupPayload(true),
      ...rows.map((item) => ({
        ...item,
        joined: joinedSlugs.has(item.slug),
        isWorld: false,
      })),
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
      creator: req.user._id,
      memberCount: 1,
    });

    await User.updateOne(
      { _id: req.user._id },
      { $addToSet: { joinedGroupSlugs: slug } }
    );

    res.status(201).json({ ok: true, group: { ...group.toObject(), joined: true, isWorld: false } });
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

    const group = await Group.findOne({ slug });
    if (!group) {
      throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
    }

    const result = await User.updateOne(
      { _id: req.user._id, joinedGroupSlugs: { $ne: slug } },
      { $addToSet: { joinedGroupSlugs: slug } }
    );

    if (result.modifiedCount > 0) {
      await Group.updateOne({ _id: group._id }, { $inc: { memberCount: 1 } });
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

    const group = await Group.findOne({ slug }).select("_id").lean();
    if (!group) {
      throw new AppError("Group not found", 404, "GROUP_NOT_FOUND");
    }

    const result = await User.updateOne(
      { _id: req.user._id, joinedGroupSlugs: slug },
      { $pull: { joinedGroupSlugs: slug } }
    );

    if (result.modifiedCount > 0) {
      await Group.updateOne({ _id: group._id }, { $inc: { memberCount: -1 } });
    }

    res.json({ ok: true, joined: false, slug });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listGroups,
  createGroup,
  joinGroup,
  leaveGroup,
};