// src/controllers/feed.controller.js
// 关注流：我关注的人发布的公开 idea，按时间倒序。
//
// 供两处消费：
// - /feed 动态页的主流（分页）
// - 首页「动态」按钮：图标取第一条的作者头像；hover dropdown 列最新几条
//
// 取代此前 HomePage 的前端 fan-out（先拉 following 再逐人拉 ideas 合并）——
// 那种拼法每次 1+N 个请求且只覆盖前 8 人；这里一条查询覆盖全部关注对象。
//
// 可选 authorId 过滤（动态页顶部头像栏「按人看」）：仍限定在我的关注集合内，
// 不放开成任意用户查询 —— 看任意用户的主页动态走既有 /api/users/:id/ideas。
const mongoose = require("mongoose");
const Follow = require("../models/Follow");
const Idea = require("../models/Idea");
const { getUserJoinedGroupSlugs, WORLD_GROUP_SLUG } = require("../utils/groups");
const { listBlockedUserIds } = require("../utils/blocking");

async function listFollowingFeed(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);

    const [follows, blockedIds] = await Promise.all([
      Follow.find({ follower: req.user._id }).select("following").lean(),
      listBlockedUserIds(req.user._id),
    ]);
    // 拉黑双向隐藏（与 listIdeas 的 blockedAuthorFilter 同语义，评审实锤）：
    // 拉黑不删关注关系，历史 follow 不能把被拉黑者的内容漏进来
    const followingIds = follows
      .map((f) => f.following)
      .filter((id) => !blockedIds.has(String(id)));
    if (!followingIds.length) {
      return res.json({ ok: true, ideas: [], total: 0, page, limit, totalPages: 1 });
    }

    let authorFilter = { $in: followingIds };
    const requestedAuthor = String(req.query.authorId || "").trim();
    if (requestedAuthor) {
      if (!mongoose.isValidObjectId(requestedAuthor)) {
        return res.json({ ok: true, ideas: [], total: 0, page, limit, totalPages: 1 });
      }
      const isFollowed = followingIds.some((id) => String(id) === requestedAuthor);
      if (!isFollowed) {
        return res.json({ ok: true, ideas: [], total: 0, page, limit, totalPages: 1 });
      }
      authorFilter = requestedAuthor;
    }

    // 群门控（评审实锤，与 listIdeas/canAccessIdeaGroup 同语义）：私有/不公开群里的
    // idea 即使 visibility=public，也只有群成员可见 —— 关注关系不授予群成员资格。
    // 用查询条件而非 post-filter，保证 total/totalPages 语义准确。
    const joinedGroupSlugs = getUserJoinedGroupSlugs(req.user);
    const filter = {
      author: authorFilter,
      visibility: "public",
      $or: [
        { groupSlug: WORLD_GROUP_SLUG },
        { groupSlug: { $exists: false } },
        { groupVisibility: "public" },
        ...(joinedGroupSlugs.length ? [{ groupSlug: { $in: joinedGroupSlugs } }] : []),
      ],
    };
    const [ideas, total] = await Promise.all([
      Idea.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username displayName avatarUrl role")
        .lean(),
      Idea.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      ideas,
      total,
      page,
      limit,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listFollowingFeed };
