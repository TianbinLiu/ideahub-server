const User = require("../models/User");
const Follow = require("../models/Follow");
const Bookmark = require("../models/Bookmark");
const TagLeaderboard = require("../models/TagLeaderboard");
const LeaderboardPost = require("../models/LeaderboardPost");
const Idea = require("../models/Idea");
const GroupJoinReferral = require("../models/GroupJoinReferral");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { searchRegex } = require("../utils/regex");
// 大小写不敏感的等值口径：与 models/User.js 上的 ci 索引、@提及查询同一个常量（铁律六）
const { CI_COLLATION: EXACT_MATCH_COLLATION } = require("../utils/username");
const { canReadIdea } = require("../utils/permissions");
const {
  ensureNoBlockForInteraction,
  ensureUsersVisibleOrThrow,
  filterItemsByBlockedUsers,
  listBlockedUserIds,
  toIdString,
} = require("../utils/blocking");

/**
 * 搜索结果排序档位（小的排前面）。
 *
 * ★ 为什么非排不可：光靠 Mongo 的自然序，输入一个完整用户名 `bob` 时，
 *   先返回的很可能是 `bobcat` / 昵称里含 "bob" 的某个人，而**本人**排在第七位 ——
 *   @提及选人的场景里这直接等于选错人（选中的是 userId，选错就 @ 了另一个人）。
 * ★ username 的档位一律高于 displayName 的同类档位：username 是唯一且不可变的身份，
 *   displayName 谁都能改成 "bob"，让它压过真正的 bob 就是一条现成的冒名路径。
 */
function searchRank(user, qLower) {
  const username = String(user.username || "").toLowerCase();
  const displayName = String(user.displayName || "").toLowerCase();
  if (username === qLower) return 0;
  if (username.startsWith(qLower)) return 1;
  if (displayName === qLower) return 2;
  if (displayName.startsWith(qLower)) return 3;
  if (username.includes(qLower)) return 4;
  return 5; // 只在 displayName 里出现的子串
}

/** 搜索结果的字段投影：回包要什么就取什么，别把整条 User（含 passwordHash）拉进内存 */
const SEARCH_FIELDS = "_id username displayName avatarUrl";

/**
 * 单次搜索允许 mongod 花的时间上限。
 *
 * ★ 为什么非有不可：模糊那一条是**全表扫**（见下），users 表一大，一次调用就能把
 *   一个 mongod 工作线程占住几秒。maxTimeMS 让"最坏情况"从"扫完为止"变成一个常数。
 * ★ 超时**不吞**（铁律八）：下面显式转成 503 + SEARCH_TIMEOUT 抛出去。
 *   吞掉返回空列表的话，用户看到的是"查无此人"—— 而真相是"服务器没查完"，
 *   这两件事在界面上必须能分开，否则用户会以为朋友把号注销了。
 */
const SEARCH_MAX_TIME_MS = Number(process.env.USER_SEARCH_MAX_TIME_MS || 800);

/** mongod 的 MaxTimeMSExpired */
const MONGO_MAX_TIME_EXPIRED = 50;

/**
 * GET /api/users/search?q=&limit=8
 * 找人（@提及选人 / 搜索框）。
 *
 * ★ 必须同时匹配 `displayName`：app 里从头到尾显示的都是 displayName，
 *   只按 username 匹配的结果是"用户搜自己每天看到的那个名字，一个人都搜不到"，
 *   而接口 200、`users: []` —— 看起来像"这个人不存在"。
 * ★ 回包**只加不减**：`_id/username` 是官网客户端已经在读的，删任何一个都会当场打断它
 *   （两仓不在一个 CI 里，也不共享发布节奏）。新增 `displayName`/`avatarUrl` 是安全的，
 *   老客户端读不到就当没有。响应键必须继续叫 `users`。
 * ★ 正则一律走 utils/regex 的 searchRegex：它把用户输入转义并截到 64 字符。
 *   自己 `new RegExp(req.query.q)` 是本仓真出过事的 ReDoS 口子（见那个文件顶部的复盘），
 *   而且这个端点只挂 optionalAuth，未登录即可打。
 *
 * ★★ 查询是**两条**，不是一条，这是为了修一个"排序根本轮不到"的静默 bug：
 *
 *   模糊那条上的 `.limit(fetchLimit)` 是 **mongod 先夹**、searchRank 在 Node 里**后排**。
 *   也就是说排序看到的只是自然序里随手截的一段。库里有 30 个名字带 "bob" 的账号时，
 *   用户把朋友的完整用户名 `bob` 一字不差地打进去，**真身可能压根没被取回来** ——
 *   界面上是 6 个陌生人，朋友怎么也搜不到，而且没有任何"结果被截断了"的迹象。
 *   （精确档 rank=0 就是为这一幕存在的，可它排的是取回来的那批。）
 *
 *   所以精确匹配单独发一条查询，与模糊那条**并行**跑，合并后再排序去重：
 *   精确命中于是与 fetchLimit 无关，永远在候选集里。
 *   这条额外查询几乎不要钱 —— 等值 + collation 能吃上 models/User.js 上那两条 ci 索引
 *   （username_ci / displayName_ci），不像模糊那条只能扫。
 */
async function searchUsers(req, res, next) {
  try {
    const raw = (req.query.q || "").toString().trim();
    const qLower = raw.toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "8", 10), 1), 20);
    const currentUserId = req.user?._id;

    if (!qLower) {
      return res.json({ ok: true, users: [] });
    }

    // ★ 不加 anchored：要支持"名字中间那一段"的匹配（"张伟" 里搜 "伟"）。
    //   代价是吃不上索引（`i` 标志下 MongoDB 不会用任何索引服务 $regex），
    //   所以靠三道闸门兜住开销：searchRegex 内部把输入截到 64 字符、下面的 fetchLimit
    //   天花板、以及 maxTimeMS。真正的门在路由上的限流（users:search）。
    const re = searchRegex(raw);
    // 多取一些再排序：排序要在**候选集**上做，只取 limit 条的话第一名可能压根没被取回来。
    // 上限 100 是天花板，不是分页 —— 找人是"看见了就点"，不是逐页翻。
    const fetchLimit = Math.min(limit * 5, 100);

    // ★ 精确档单独取（见上）。collation strength:2 = 大小写不敏感的等值，与
    //   utils/mentionParser 的 MENTION_COLLATION 逐字相同（@提及和搜索必须认同一个
    //   "精确"，否则会出现"搜得到但 @ 不到"）。
    //
    // ★★ username 与 displayName 分成**两发**，不能合成一个 $or 再 .limit()。
    //   displayName 既不唯一也不可信：只要有 limit 个人把昵称改成 "bob"，
    //   一个 $or + limit(8) 就可能被这些冒名者占满，账号真的叫 bob 的那个人
    //   **根本不会被取回来** —— 而 searchRank 只能给取回来的行排序。
    //   表现是：你按朋友的账号名精确搜索，结果里全是冒名的人，朋友查无此人。
    //   username 是唯一索引，那一发最多回一行，代价可以忽略。
    const [fuzzy, exactName, exactDisplay] = await Promise.all([
      User.find({ $or: [{ username: re }, { displayName: re }] })
        .select(SEARCH_FIELDS)
        .limit(fetchLimit)
        .maxTimeMS(SEARCH_MAX_TIME_MS)
        .lean(),
      // 唯一索引 + 等值：最多一行，永远不会被别人挤掉
      User.findOne({ username: raw })
        .select(SEARCH_FIELDS)
        .collation(EXACT_MATCH_COLLATION)
        .maxTimeMS(SEARCH_MAX_TIME_MS)
        .lean(),
      User.find({ displayName: raw })
        .select(SEARCH_FIELDS)
        .collation(EXACT_MATCH_COLLATION)
        .limit(limit)
        .maxTimeMS(SEARCH_MAX_TIME_MS)
        .lean(),
    ]);

    // 合并去重：精确的放前面只是为了让稳定排序在同档位里也偏向它，
    // 真正的名次仍然由 searchRank 决定（这里不许悄悄替代排序规则）。
    const users = [];
    const seenIds = new Set();
    for (const u of [...(exactName ? [exactName] : []), ...exactDisplay, ...fuzzy]) {
      const key = String(u._id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      users.push(u);
    }

    // 拉黑过滤必须留着：去掉它，被别人拉黑的人就能在搜索框里把对方搜出来
    const blockedUserIds = currentUserId ? await listBlockedUserIds(currentUserId) : new Set();
    const visibleUsers = filterItemsByBlockedUsers(users, blockedUserIds, (user) => user._id);

    // sort 在 Node 上是稳定的，同档位保持库里的自然序
    const ranked = visibleUsers
      .map((u) => ({ u, rank: searchRank(u, qLower) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit)
      .map(({ u }) => ({
        _id: u._id,
        username: u.username || "",
        displayName: u.displayName || "",
        avatarUrl: u.avatarUrl || "",
      }));

    res.json({ ok: true, users: ranked });
  } catch (err) {
    // ★ 超时**必须说出来**（铁律八）：吞掉返回 `users: []` 的话，界面上
    //   "服务器没查完" 和 "查无此人" 长得一模一样，用户会以为对方注销了账号。
    //   503 让客户端知道这是一次可重试的失败，而不是一个结论。
    if (err && (err.code === MONGO_MAX_TIME_EXPIRED || err.codeName === "MaxTimeMSExpired")) {
      console.warn(`[users] 搜索超时(${SEARCH_MAX_TIME_MS}ms) q.len=${String(req.query.q || "").length}`);
      return next(
        new AppError({
          code: CODES.SERVER_ERROR,
          status: 503,
          message: "Search timed out, please try again",
        })
      );
    }
    next(err);
  }
}

/**
 * GET /api/users/:id
 * Get public user profile
 */
async function getUserProfile(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    const user = await User.findById(id).select('username displayName bio avatarUrl role createdAt');
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    // Count followers and following
    const followerCount = await Follow.countDocuments({ following: id });
    const followingCount = await Follow.countDocuments({ follower: id });

    // Check if current user follows this user
    let isFollowing = false;
    if (currentUserId && currentUserId !== id) {
      const follow = await Follow.findOne({ follower: currentUserId, following: id });
      isFollowing = !!follow;
    }

    res.json({
      ok: true,
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt,
        followerCount,
        followingCount,
        isFollowing,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users/:id/follow
 * Toggle follow/unfollow
 */
async function toggleFollow(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user._id.toString();

    if (currentUserId === id) {
      throw new AppError('Cannot follow yourself', 400, 'CANNOT_FOLLOW_SELF');
    }

    const targetUser = await User.findById(id);
    if (!targetUser) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    await ensureNoBlockForInteraction(currentUserId, id, 'Blocked users cannot follow each other.');

    const existing = await Follow.findOne({ follower: currentUserId, following: id });

    if (existing) {
      // Unfollow
      await Follow.deleteOne({ _id: existing._id });
      return res.json({ ok: true, following: false });
    } else {
      // Follow
      await Follow.create({ follower: currentUserId, following: id });
      return res.json({ ok: true, following: true });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/followers
 * Get user's followers
 */
async function getFollowers(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString() || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    const rows = await Follow.find({ following: id })
      .populate('follower', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .lean();

    const [subjectBlockedUserIds, viewerBlockedUserIds] = await Promise.all([
      listBlockedUserIds(id),
      currentUserId ? listBlockedUserIds(currentUserId) : Promise.resolve(new Set()),
    ]);
    const hiddenUserIds = new Set([...subjectBlockedUserIds, ...viewerBlockedUserIds]);
    const filteredFollowers = filterItemsByBlockedUsers(rows, hiddenUserIds, (row) => row.follower?._id || row.follower);
    const total = filteredFollowers.length;
    const followers = filteredFollowers
      .slice((page - 1) * limit, page * limit)
      .map((row) => row.follower)
      .filter(Boolean);

    res.json({
      ok: true,
      followers,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/following
 * Get users that this user follows
 */
async function getFollowing(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString() || "";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    const rows = await Follow.find({ follower: id })
      .populate('following', 'username displayName avatarUrl')
      .sort({ createdAt: -1 })
      .lean();

    const [subjectBlockedUserIds, viewerBlockedUserIds] = await Promise.all([
      listBlockedUserIds(id),
      currentUserId ? listBlockedUserIds(currentUserId) : Promise.resolve(new Set()),
    ]);
    const hiddenUserIds = new Set([...subjectBlockedUserIds, ...viewerBlockedUserIds]);
    const filteredFollowing = filterItemsByBlockedUsers(rows, hiddenUserIds, (row) => row.following?._id || row.following);
    const total = filteredFollowing.length;
    const following = filteredFollowing
      .slice((page - 1) * limit, page * limit)
      .map((row) => row.following)
      .filter(Boolean);

    res.json({
      ok: true,
      following,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/bookmarks
 * Get user's public bookmarks (ideas and leaderboards)
 */
async function getUserBookmarks(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    // Only show bookmarks if viewing own profile or if user is admin
    const isOwnProfile = currentUserId === id;
    const isAdmin = req.user?.role === 'admin';

    if (!isOwnProfile && !isAdmin) {
      return res.json({
        ok: true,
        ideas: [],
        leaderboards: [],
      });
    }

    const bookmarks = await Bookmark.find({ user: id })
      .populate('idea', 'title summary tags createdAt author')
      .populate('leaderboard', 'tags computedAt author')
      .sort({ createdAt: -1 });

    const blockedUserIds = await listBlockedUserIds(id);

    const ideas = bookmarks
      .filter(b => b.type === 'idea' && b.idea)
      .map(b => b.idea)
      .filter((idea) => !blockedUserIds.has(toIdString(idea.author)) && canReadIdea(idea, req.user));

    const leaderboards = bookmarks
      .filter(b => b.type === 'leaderboard' && b.leaderboard)
      .map(b => b.leaderboard)
      .filter((leaderboard) => !blockedUserIds.has(toIdString(leaderboard.author)));

    res.json({ ok: true, ideas, leaderboards });
  } catch (err) {
    next(err);
  }
}

async function getUserIdeas(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const requestedIdeaType = String(req.query.ideaType || "").trim().toLowerCase();

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    const baseFilter = { author: id };
    if (requestedIdeaType) {
      baseFilter.ideaType = requestedIdeaType;
    }

    const blockedUserIds = currentUserId ? await listBlockedUserIds(currentUserId) : new Set();
    const rows = await Idea.find(baseFilter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("author", "_id username role")
      .lean();

    const ideas = rows.filter((idea) => {
      if (blockedUserIds.has(toIdString(idea.author))) return false;
      return canReadIdea(idea, req.user);
    });

    res.json({ ok: true, ideas });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id/leaderboards
 * Get leaderboards created by user
 */
async function getUserLeaderboards(req, res, next) {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);
    const currentUserId = req.user?._id?.toString();

    if (currentUserId && currentUserId !== id) {
      await ensureUsersVisibleOrThrow(currentUserId, id);
    }

    const [items, total] = await Promise.all([
      TagLeaderboard.find({ author: id })
        .sort({ computedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id tags tagsKey computedAt entries")
        .lean(),
      TagLeaderboard.countDocuments({ author: id }),
    ]);

    const tagsKeys = items.map((b) => b.tagsKey).filter(Boolean);
    const postsCounts = await LeaderboardPost.aggregate([
      { $match: { tagsKey: { $in: tagsKeys } } },
      { $group: { _id: "$tagsKey", count: { $sum: 1 } } },
    ]);
    const postsCountMap = Object.fromEntries(postsCounts.map((p) => [p._id, p.count]));

    const payload = items.map((b) => ({
      _id: b._id,
      tags: b.tags,
      tagsKey: b.tagsKey,
      computedAt: b.computedAt,
      entriesCount: (b.entries || []).length,
      postsCount: postsCountMap[b.tagsKey] || 0,
    }));

    res.json({ ok: true, items: payload, total, page, limit });
  } catch (err) {
    next(err);
  }
}

async function getUserGroupReferrals(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user?._id?.toString();
    const isOwnProfile = currentUserId === id;
    const isAdmin = req.user?.role === "admin";

    if (!isOwnProfile && !isAdmin) {
      return res.json({ ok: true, referrals: [] });
    }

    const referrals = await GroupJoinReferral.find({ referrer: id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("invitee", "_id username displayName avatarUrl")
      .lean();

    res.json({ ok: true, referrals });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/users/:id
 * Delete user account (irreversible)
 * Requires authentication and user must be deleting their own account
 */
async function deleteAccount(req, res, next) {
  try {
    const { id } = req.params;
    const currentUserId = req.user._id.toString();

    // User can only delete their own account
    if (currentUserId !== id) {
      throw new AppError('Cannot delete another user account', 403, 'FORBIDDEN');
    }

    // Delete the user account
    const result = await User.findByIdAndDelete(id);
    if (!result) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    res.json({ ok: true, message: 'Account deleted successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = { 
  searchUsers,
  getUserProfile,
  toggleFollow,
  getFollowers,
  getFollowing,
  getUserBookmarks,
  getUserIdeas,
  getUserLeaderboards,
  getUserGroupReferrals,
  deleteAccount,
};

