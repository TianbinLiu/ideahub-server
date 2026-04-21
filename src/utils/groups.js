const Group = require("../models/Group");

const WORLD_GROUP_SLUG = "world";
const WORLD_GROUP_NAME = "World";

function normalizeGroupSlug(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return value || WORLD_GROUP_SLUG;
}

function getUserJoinedGroupSlugs(user) {
  if (!user || !Array.isArray(user.joinedGroupSlugs)) {
    return [];
  }

  return [...new Set(user.joinedGroupSlugs.map((item) => normalizeGroupSlug(item)).filter((item) => item && item !== WORLD_GROUP_SLUG))];
}

function getAccessibleGroupSlugs(user) {
  return [WORLD_GROUP_SLUG, ...getUserJoinedGroupSlugs(user)];
}

function isWorldGroupSlug(slug) {
  return normalizeGroupSlug(slug) === WORLD_GROUP_SLUG;
}

function getIdeaGroupSlug(idea) {
  return normalizeGroupSlug(idea?.groupSlug || WORLD_GROUP_SLUG);
}

function canAccessIdeaGroup(idea, user) {
  const groupSlug = getIdeaGroupSlug(idea);
  if (groupSlug === WORLD_GROUP_SLUG) return true;
  if (!user) return false;
  if (String(idea?.author?._id || idea?.author || "") === String(user._id || "")) return true;
  if (user.role === "admin") return true;
  return getUserJoinedGroupSlugs(user).includes(groupSlug);
}

async function resolveGroupSnapshot(groupSlug) {
  const normalizedSlug = normalizeGroupSlug(groupSlug);
  if (normalizedSlug === WORLD_GROUP_SLUG) {
    return { groupSlug: WORLD_GROUP_SLUG, groupName: WORLD_GROUP_NAME };
  }

  const group = await Group.findOne({ slug: normalizedSlug }).select("name slug").lean();
  if (!group) {
    return null;
  }

  return {
    groupSlug: group.slug,
    groupName: group.name,
  };
}

function buildWorldGroupPayload(joined = true) {
  return {
    _id: WORLD_GROUP_SLUG,
    name: WORLD_GROUP_NAME,
    slug: WORLD_GROUP_SLUG,
    description: "Default global group visible to everyone.",
    memberCount: null,
    joined,
    isWorld: true,
    creator: null,
  };
}

module.exports = {
  WORLD_GROUP_SLUG,
  WORLD_GROUP_NAME,
  normalizeGroupSlug,
  getUserJoinedGroupSlugs,
  getAccessibleGroupSlugs,
  isWorldGroupSlug,
  getIdeaGroupSlug,
  canAccessIdeaGroup,
  resolveGroupSnapshot,
  buildWorldGroupPayload,
};