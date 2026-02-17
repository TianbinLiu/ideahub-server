// src/utils/permissions.js
function isOwner(idea, user) {
  if (!idea || !user || !user._id) return false;
  // idea.author may be an ObjectId or a populated user object; normalize to id string
  const authorId = idea.author && (idea.author._id || idea.author);
  return !!authorId && String(authorId) === String(user._id);
}

function canReadIdea(idea, user) {
  if (!idea) return false;
  if (idea.visibility === "public") return true;
  if (idea.visibility === "unlisted") return true;

  // private
  if (!user) return false;
  return isOwner(idea, user) || user.role === "admin";
}

function canWriteIdea(idea, user) {
  if (!user) return false;
  return isOwner(idea, user) || user.role === "admin";
}

function canInteractIdea(idea, user) {
  // 点赞/评论/收藏：至少要能 read，并且必须登录
  if (!user) return false;
  return canReadIdea(idea, user);
}

function canCompanyInterest(idea, user) {
  if (!user) return false;
  if (user.role !== "company") return false;
  // private idea 不允许企业 interest（除非你想允许）
  if (idea.visibility === "private") return false;
  // 企业不能 interest 自己的 idea
  return !isOwner(idea, user);
}

module.exports = {
  isOwner,
  canReadIdea,
  canWriteIdea,
  canInteractIdea,
  canCompanyInterest,
};
