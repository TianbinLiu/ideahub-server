const Group = require("../models/Group");

const WORLD_GROUP_SLUG = "world";
const WORLD_GROUP_NAME = "World";
const GROUP_VISIBILITIES = new Set(["public", "private", "unlisted"]);

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

function normalizeGroupVisibility(raw, fallback = "public") {
  const value = String(raw || "").trim().toLowerCase();
  return GROUP_VISIBILITIES.has(value) ? value : fallback;
}

function getGroupManagerIds(group) {
  if (!group) return [];
  const ids = [];
  if (group.creator) ids.push(String(group.creator?._id || group.creator));
  if (Array.isArray(group.adminIds)) {
    for (const id of group.adminIds) ids.push(String(id?._id || id));
  }
  return [...new Set(ids.filter(Boolean))];
}

function isGroupManager(group, user) {
  if (!group || !user) return false;
  if (user.role === "admin") return true;
  return getGroupManagerIds(group).includes(String(user._id || user));
}

async function isGroupManagerBySlug(groupSlug, user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const slug = normalizeGroupSlug(groupSlug);
  if (slug === WORLD_GROUP_SLUG) return user.role === "admin";
  const group = await Group.findOne({ slug }).select("creator adminIds").lean();
  return isGroupManager(group, user);
}

function getIdeaGroupSlug(idea) {
  return normalizeGroupSlug(idea?.groupSlug || WORLD_GROUP_SLUG);
}

function canAccessIdeaGroup(idea, user) {
  const groupSlug = getIdeaGroupSlug(idea);
  if (groupSlug === WORLD_GROUP_SLUG) return true;
  if (normalizeGroupVisibility(idea?.groupVisibility, "private") === "public") return true;
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

  const group = await Group.findOne({ slug: normalizedSlug }).select("name slug visibility").lean();
  if (!group) {
    return null;
  }

  return {
    groupSlug: group.slug,
    groupName: group.name,
    groupVisibility: normalizeGroupVisibility(group.visibility, "private"),
  };
}

function buildWorldGroupPayload(joined = true) {
  return {
    _id: WORLD_GROUP_SLUG,
    name: WORLD_GROUP_NAME,
    slug: WORLD_GROUP_SLUG,
    description: "Default global group visible to everyone.",
    visibility: "public",
    memberCount: null,
    joined,
    isWorld: true,
    creator: null,
    canManage: false,
    canCreateInvite: false,
  };
}

module.exports = {
  WORLD_GROUP_SLUG,
  WORLD_GROUP_NAME,
  normalizeGroupSlug,
  normalizeGroupVisibility,
  getUserJoinedGroupSlugs,
  getAccessibleGroupSlugs,
  isWorldGroupSlug,
  getGroupManagerIds,
  isGroupManager,
  isGroupManagerBySlug,
  getIdeaGroupSlug,
  canAccessIdeaGroup,
  resolveGroupSnapshot,
  buildWorldGroupPayload,
};