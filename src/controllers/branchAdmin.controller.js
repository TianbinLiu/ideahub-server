// src/controllers/branchAdmin.controller.js
// 后台的**用户管理**与**内容钻取**。门在 routes/branchAdmin.routes.js 上统一开
// （requireAuth + requireRole(admin)），这里不再判身份。
//
// ★ 为什么单开一个文件而不是继续塞 branchVideo.controller：那个文件已经 1800 行，
//   而这里的主角是 **User**（封禁 / 级联删除 / 发通知），与作品那条线只在
//   「复用清理与序列化」处相交。复用件全部从 branchVideo/branchAsset.controller
//   **导入**（purgeVideo / purgeComments / syncLikes / syncCommentLikes /
//   toVideoPayload / recountAssetStat）——本文件**不写第二份**清理或序列化逻辑（铁律六）。
//
// ★★ 封禁与内容处置**两权分开**（产品拍板）：封人挡的是「登录与一切带 token 的请求」
//   （utils/banned.js + signToken + requireAuth），**不**自动隐藏其内容。
//   内容要下架/删除，走每条内容自己的端点。理由见 models/User.js banned 字段的注释。
const mongoose = require("mongoose");
const User = require("../models/User");
const BranchVideo = require("../models/BranchVideo");
const BranchComment = require("../models/BranchComment");
const BranchCommentLike = require("../models/BranchCommentLike");
const BranchLike = require("../models/BranchLike");
const BranchDanmaku = require("../models/BranchDanmaku");
const BranchCard = require("../models/BranchCard");
const BranchTemplate = require("../models/BranchTemplate");
const BranchTemplateTrial = require("../models/BranchTemplateTrial");
const PendingAssetPurge = require("../models/PendingAssetPurge");
const { ownedRecyclableAsset, RECYCLABLE_FOLDERS } = require("../utils/templateVideoAsset");
const BranchDeck = require("../models/BranchDeck");
const BranchAssetLike = require("../models/BranchAssetLike");
const BranchAssetStat = require("../models/BranchAssetStat");
const Report = require("../models/Report");
const TokenLedger = require("../models/TokenLedger");
const TokenOrder = require("../models/TokenOrder");
const Follow = require("../models/Follow");
const Notification = require("../models/Notification");
const SearchHistory = require("../models/SearchHistory");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
// 用户输入 → 搜索正则的唯一收口（别自己 new RegExp，那是本仓出过 41.7s ReDoS 的口子）
const { searchRegex } = require("../utils/regex");
// 「谁是管理员」只有 utils/roles 一处判据（铁律六）
const { isAdmin } = require("../utils/roles");
// 封禁判据（文档侧 + 查询侧）与文案，全在 utils/banned.js 一处
const { isBanned, BANNED_FILTER, NOT_BANNED_FILTER } = require("../utils/banned");
// 清理 / 序列化 / 计数回写：全部复用既有实现，本文件只调用（铁律六）
const {
  purgeVideo,
  purgeComments,
  syncLikes,
  syncCommentLikes,
  toVideoPayload,
  TAKEN_DOWN,
  NOT_TAKEN_DOWN,
  AUTHOR_FIELDS,
} = require("./branchVideo.controller");
const { recountAssetStat } = require("./branchAsset.controller");
// 通知写入一律走 service（全站唯一入口），不在这里 create
const { createNotification } = require("../services/notification.service");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

/** 与 report.controller 的 listReports 同一套分页口径：page 从 1 起，limit 上限 50 */
function pageParams(req) {
  const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);
  return { page, limit };
}

// ── 用户列表 ─────────────────────────────────────────────────────

/**
 * PII 打码。★ 管理员列表**不回 email/phone 全文**：列表的用途是「认出这个人、
 * 看他的状态」，全文 PII 在这里一个用途都没有，却会让每次打开后台都把全站
 * 联系方式拉到一台客户端上 —— 泄露面从「数据库被攻破」扩大到「任何一个管理员
 * 账号被钓走」。打码后仍够肉眼对上「是不是同一个邮箱/手机」。
 */
function maskEmail(email) {
  const raw = String(email || "");
  const at = raw.indexOf("@");
  if (at <= 0) return raw ? "***" : "";
  return `${raw[0]}***@${raw.slice(at + 1)}`;
}

function maskPhone(phone) {
  const raw = String(phone || "");
  if (!raw) return "";
  if (raw.length <= 7) return "***";
  return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
}

/**
 * 后台视角的一个用户。banned 带 at/reason（**不带 by**：回包字段按契约来，
 * 「谁封的」在库与操作日志里，后台列表用不上就不给 —— 少一处泄露面）。
 */
function toAdminUserPayload(doc, counts = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    username: doc.username || "",
    displayName: doc.displayName || "",
    avatarUrl: doc.avatarUrl || "",
    role: doc.role || "user",
    email: maskEmail(doc.email),
    // phone 是 sparse 字段，没有就不给这个键（别给空串 —— 空串会被当成「有手机号但打码没了」）
    ...(doc.phone ? { phone: maskPhone(doc.phone) } : {}),
    createdAt: doc.createdAt,
    videoCount: Number(counts.videos || 0),
    commentCount: Number(counts.comments || 0),
    // 与 takedown 同一种给法：有这个键 = 被封，没有 = 正常
    ...(isBanned(doc) ? { banned: { at: doc.banned.at, reason: doc.banned.reason || "" } } : {}),
  };
}

/**
 * GET /api/admin/branch/users —— 分页 + 搜索 + 筛选。
 * query：page / limit / q（username 或 displayName 子串，大小写不敏感）/
 *        role（user|company|admin）/ banned（"1" 只看被封的，"0" 只看没封的）
 *
 * ★ 作品数/评论数用**一次 $group 聚合**数完一页的人，不逐人 countDocuments：
 *   一页 50 人 × 2 张表就是 100 次往返；聚合走的还是同一条 author/owner 索引，
 *   语义与 countDocuments 完全相同（都不捞整行）。
 */
async function listUsers(req, res, next) {
  try {
    const { page, limit } = pageParams(req);

    const parts = [];

    const q = String(req.query.q || "").trim();
    if (q) {
      // 子串匹配复用 utils/regex 的 searchRegex（转义 + 截 64 字符），与找人搜索同一口径。
      // 大小写不敏感由 "i" 标志承担 —— CI_COLLATION 是**等值**查询的口径，管不到 $regex。
      const re = searchRegex(q);
      parts.push({ $or: [{ username: re }, { displayName: re }] });
    }

    const role = String(req.query.role || "").trim();
    if (role) {
      // 合法取值以 User schema 的 enum 为唯一出处，别在这里抄一份字符串数组
      const allowed = User.schema.path("role").enumValues;
      if (!allowed.includes(role)) badRequest(`Invalid role: ${role.slice(0, 20)}`);
      parts.push({ role });
    }

    // 封禁筛选：判据的查询侧写法只有 utils/banned.js 一处。
    // 值拼错时报 400 而不是静默当成「不筛」——悄悄给另一份数据比报错难查得多（铁律八）
    const bannedRaw = String(req.query.banned ?? "").trim();
    if (bannedRaw === "1") parts.push(BANNED_FILTER);
    else if (bannedRaw === "0") parts.push(NOT_BANNED_FILTER);
    else if (bannedRaw) badRequest(`Invalid banned filter: ${bannedRaw.slice(0, 20)} (use "1" or "0")`);

    const filter = parts.length ? { $and: parts } : {};

    const [rows, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("_id username displayName avatarUrl role email phone createdAt banned")
        .lean(),
      User.countDocuments(filter),
    ]);

    const ids = rows.map((u) => u._id);
    const [videoAgg, commentAgg] = ids.length
      ? await Promise.all([
          BranchVideo.aggregate([{ $match: { author: { $in: ids } } }, { $group: { _id: "$author", n: { $sum: 1 } } }]),
          BranchComment.aggregate([{ $match: { author: { $in: ids } } }, { $group: { _id: "$author", n: { $sum: 1 } } }]),
        ])
      : [[], []];
    const videoCounts = new Map(videoAgg.map((r) => [String(r._id), r.n]));
    const commentCounts = new Map(commentAgg.map((r) => [String(r._id), r.n]));

    res.json({
      ok: true,
      items: rows.map((u) =>
        toAdminUserPayload(u, {
          videos: videoCounts.get(String(u._id)),
          comments: commentCounts.get(String(u._id)),
        })
      ),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

// ── 封禁 / 解封 ──────────────────────────────────────────────────

/** 封禁原因长度上限。与 models/User.js 里 banned.reason 的 maxlength 同一个数（铁律六） */
const BAN_REASON_MAX = 500;

/** 取封禁/删除的目标用户，顺带做 id 与存在性检查 */
async function loadTargetUser(id, select = "_id username role banned") {
  if (!isValidId(id)) invalidId("Invalid user id");
  const doc = await User.findById(id).select(select).lean();
  if (!doc) notFound("User not found");
  return doc;
}

/**
 * POST /api/admin/branch/users/:id/ban —— 封禁（可逆）。body: { reason 必填 }
 *
 * ★ 拒绝封禁管理员（403）：封禁挡的是登录与一切带 token 的请求，封掉一个管理员
 *   等于当场把他踢出后台 —— 两个管理员互相点一下就能把对方（乃至整个后台）锁死。
 *   真要处置一个管理员：先降权（role 改回 user），再封。判据 isAdmin 只有一处。
 * ★ 重复封禁不报错，覆盖成最新的 by/at/reason（与 takedownVideo 同一条理由：
 *   换个原因重封、后台重复点，都不该失败）。
 * ★ reason 必填：被封的人第一反应是「为什么」。这句话会通过 401/403 的 message
 *   原样到他眼前（utils/banned.js 的 bannedMessage）。
 */
async function banUser(req, res, next) {
  try {
    const { id } = req.params;
    const target = await loadTargetUser(id);

    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) badRequest("reason is required");
    if (reason.length > BAN_REASON_MAX) badRequest(`reason too long (max ${BAN_REASON_MAX})`);

    if (isAdmin(target)) forbidden("不能封禁管理员账号：要处置请先把他的 role 降为 user");

    await User.updateOne(
      { _id: target._id },
      { $set: { banned: { by: req.user._id, at: new Date(), reason } } }
    );

    // 管理员对别人的不可见操作必须留痕（铁律八）
    console.warn(
      `[branchAdmin] 封禁用户 user=${id} username=${target.username} admin=${req.user._id} reason=${reason.slice(0, 80)}`
    );

    const fresh = await User.findById(id)
      .select("_id username displayName avatarUrl role email phone createdAt banned")
      .lean();
    res.json({ ok: true, user: toAdminUserPayload(fresh) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/admin/branch/users/:id/ban —— 解封。
 * ★ $unset 整个子文档（不是 $set null），理由与撤销下架逐字相同：
 *   「有没有这个键」就是判据本身，null 会留下一堆半截记录。
 * ★ 幂等：对没封的人解封直接 200（后台重复点不该报错）。
 */
async function unbanUser(req, res, next) {
  try {
    const { id } = req.params;
    const target = await loadTargetUser(id);

    await User.updateOne({ _id: target._id }, { $unset: { banned: "" } });

    console.warn(`[branchAdmin] 解封用户 user=${id} username=${target.username} admin=${req.user._id}`);

    const fresh = await User.findById(id)
      .select("_id username displayName avatarUrl role email phone createdAt banned")
      .lean();
    res.json({ ok: true, user: toAdminUserPayload(fresh) });
  } catch (err) {
    next(err);
  }
}

// ── 删除账号（硬删 + 级联）───────────────────────────────────────

/**
 * 级联删一个用户要清的所有东西。**逐个 model 列全**，并说明为什么删/为什么不删：
 *
 *   删（本函数负责）：
 *   ① BranchVideo（他的作品）      → 逐条 purgeVideo（唯一清理实现：连带该作品下
 *                                     所有人的评论/点赞/弹幕/指向它的通知）
 *   ② BranchComment（他发在**别人**作品下的评论）→ 逐条 purgeComments（连带楼中楼
 *                                     回复、点赞行、指向它的通知、commentCount 回写）
 *   ③ BranchDanmaku（他发在别人作品下的弹幕）→ deleteMany（弹幕无级联：不发通知、
 *                                     没有点赞表 —— 与 takedown.service 同口径）
 *   ④ BranchLike / BranchCommentLike（他点过的赞）→ 删行 + 受影响作品/评论的计数
 *                                     快照重算（syncLikes / syncCommentLikes，一处实现）
 *   ⑤ BranchAssetLike（他对别人卡片/卡组的赞/收藏）→ 删行 + recountAssetStat 重算
 *   ⑥ BranchDeck（他的卡组）        → 删卡组 + 该卡组的 BranchAssetStat/Like 行
 *                                     （key 是已发布卡组的 _id，卡组没了这些行谁也查不到）
 *   ⑦ BranchCard（他的卡片）        → deleteMany。
 *      ★ 卡片的 BranchAssetStat **不删**：kind="card" 的 key 是 cardId，是**跨用户
 *        全局聚合**的（同一张市场卡在每个装过的人库里都有一份文档）—— 删掉计数会把
 *        别人手里同一张卡的热度一起清零，那是丢别人的数据。
 *   ⑦.5 BranchTemplate（他做的白模模板）→ 句柄落 PendingAssetPurge 后 deleteMany，
 *      顺带清 BranchTemplateTrial（试用记录）。
 *      ★★ 2026-08-31 补。**它此前既不在"删"的清单里，也不在下面"不删（刻意的）"
 *      的清单里 —— 是纯遗漏**，整个文件一次都没提到 BranchTemplate。后果不是少删一张表：
 *      模板市场的列表是裸的 `find({ status: "published" })`（不查作者在不在），
 *      于是被永久删号的人发布的模板**原封不动留在货架上**，别人照样套用出片、
 *      照样按 r2v 付费，卡片还挂着已删账号的 authorName 快照；而那份 100MB 级的
 *      参考视频/原始素材在产品内**再没有任何把手能删**（模板的删除端点只认 ownerId
 *      本人，而那个人已经不存在了；孤儿回收口在模板还在时是拒删的）。全程零报错。
 *      ⚠ 资产走 PendingAssetPurge + sweepPendingPurges，**不在这里抄第二份回收逻辑**：
 *      顺序（refVideo → 封面 → source → 分段组末段）与 DELETE /templates/:id 一致，
 *      但那边是同步 destroy、这边是欠账重试 —— 一个管理员操作不该被一次云端抖动挡住。
 *   ⑧ Report（他提交的 + 指向他内容的）→ deleteMany。指向的内容随①②③一起没了，
 *      留着只会是一队 target.exists=false 的死举报，谁也处理不了。
 *   ⑨ TokenLedger / TokenOrder（token 钱包流水与订单）→ deleteMany。
 *      token 是对外采购的算力额度，**没有对手方**，删他自己的流水不破坏任何不变量。
 *   ⑩ Follow（关注与被关注）、Notification（他收的 + 他触发的）、SearchHistory
 *      （他的搜索记录，用户私有数据）→ deleteMany
 *   ⑪ User 本体（最后删：中途挂了还能重来，先删 User 就再也找不到线索了）
 *
 *   不删（刻意的，不是遗漏）：
 *   · PointsLedger —— 复式记账，硬不变量是「除 signup 外所有分录和为零」（I1，机器可查）。
 *     删掉他那一侧的分录，对手方的分录就永远配不平，整本账从此说不清 ——
 *     账本是只追加的审计记录，人没了账也得在。
 *   · BranchAssetView —— TTL 索引一天内自清，且 viewer 是不可逆哈希，够不成 PII。
 *   · ideas 产品线的内容（Idea/Comment/Like/Group/DM…）—— 本次范围是分支视频这条线
 *     的后台；那边的级联要动 30+ 张表，且有自己的软删除体系（deactivatedAt），
 *     混在这里做一半比不做更糟。作者字段悬空后 populate 出 null，读侧已按
 *     「用户不存在」兜底。⚠ 这是**已知未尽事项**，做 ideas 后台时要补。
 *
 * ★ 串行而不是 Promise.all 一把梭：purgeVideo/purgeComments 内部各自并行过了，
 *   外层再并行只会放大瞬时连接数；而且串行让 removed 计数与日志顺序可读。
 */
async function purgeUserCascade(userId) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const removed = {};

  // ── 预收集：⑧ 要用的 id 集合（等①②③删完就再也查不到了）
  const videoIds = (await BranchVideo.find({ author: uid }).select("_id").lean()).map((v) => v._id);
  const ownCommentIds = (
    await BranchComment.find({ $or: [{ video: { $in: videoIds } }, { author: uid }] }).select("_id").lean()
  ).map((c) => c._id);
  // 他评论下别人的回复也会被②连带删掉（孤儿楼中楼），指向它们的举报同样要清
  const replyIds = (
    await BranchComment.find({ parent: { $in: ownCommentIds } }).select("_id").lean()
  ).map((c) => c._id);
  const commentIds = [...ownCommentIds, ...replyIds];
  const danmakuIds = (
    await BranchDanmaku.find({ $or: [{ video: { $in: videoIds } }, { author: uid }] }).select("_id").lean()
  ).map((d) => d._id);

  // ① 作品
  for (const vid of videoIds) await purgeVideo(vid);
  removed.videos = videoIds.length;

  // ② 他发在别人作品下的评论（自己作品下的已随①没了）
  const strayComments = await BranchComment.find({ author: uid }).select("_id video").lean();
  removed.comments = 0;
  for (const c of strayComments) {
    const r = await purgeComments(c.video, c._id);
    removed.comments += r.removed;
  }

  // ③ 弹幕
  removed.danmaku = (await BranchDanmaku.deleteMany({ author: uid })).deletedCount;

  // ④ 点过的赞（先记下受影响对象，删完行再重算快照）
  const likeRows = await BranchLike.find({ user: uid }).select("video").lean();
  removed.likesGiven = (await BranchLike.deleteMany({ user: uid })).deletedCount;
  for (const v of new Set(likeRows.map((r) => String(r.video)))) await syncLikes(v);

  const commentLikeRows = await BranchCommentLike.find({ user: uid }).select("comment").lean();
  removed.commentLikesGiven = (await BranchCommentLike.deleteMany({ user: uid })).deletedCount;
  for (const c of new Set(commentLikeRows.map((r) => String(r.comment)))) await syncCommentLikes(c);

  // ⑤ 他对别人卡片/卡组的赞/收藏。
  // ★ 必须在⑥之前：⑥会把他自己卡组的 stat 行删掉，若先⑥后⑤，这里的 recount
  //   （内部是 upsert）会给已经删掉的卡组**重新造出**一行幽灵计数。
  const assetRows = await BranchAssetLike.find({ user: uid }).select("kind key").lean();
  removed.assetLikesGiven = (await BranchAssetLike.deleteMany({ user: uid })).deletedCount;
  const seenAsset = new Set();
  for (const r of assetRows) {
    const k = `${r.kind}\u0000${r.key}`;
    if (seenAsset.has(k)) continue;
    seenAsset.add(k);
    await recountAssetStat(r.kind, r.key);
  }

  // ⑥ 卡组（连带别人对它点的赞/收藏行与计数行）
  const deckIds = (await BranchDeck.find({ owner: uid }).select("_id").lean()).map((d) => String(d._id));
  if (deckIds.length) {
    await BranchAssetLike.deleteMany({ kind: "deck", key: { $in: deckIds } });
    await BranchAssetStat.deleteMany({ kind: "deck", key: { $in: deckIds } });
  }
  removed.decks = (await BranchDeck.deleteMany({ owner: uid })).deletedCount;

  // ⑦ 卡片（计数不删，理由见函数头）
  removed.cards = (await BranchCard.deleteMany({ owner: uid })).deletedCount;

  // ⑦.5 白模模板（理由见函数头 ★★）。顺序与 DELETE /templates/:id 一致：
  //     refVideo → 封面 → 原始素材 → （删完之后）分段组的最后一段带走组源视频。
  const templates = await BranchTemplate.find({ ownerId: uid })
    .select("_id coverUrl refVideo source group")
    .lean();
  if (templates.length) {
    const handles = [];
    const push = (publicId, resourceType, source) => {
      if (publicId) handles.push({ publicId: String(publicId), resourceType, owner: uid, source: String(source) });
    };
    for (const t of templates) {
      // 模板视频的 publicId 是我们自己签发的，直接用（不经 ownedRecyclableAsset：
      // 那个函数认的是 URL，而这里手里就是 public_id）
      push(t.refVideo && t.refVideo.cloudinaryPublicId, "video", t._id);
      push(t.source && t.source.publicId, "video", t._id);
      // 封面是 URL，要先判"是不是我们空间里、这个人自己的"——认不出的一律不动
      const cover = ownedRecyclableAsset(t.coverUrl, String(uid), RECYCLABLE_FOLDERS);
      if (cover) handles.push({ ...cover, owner: uid, source: String(t._id) });
    }
    const groupKeys = [...new Set(templates.map((t) => t.group && t.group.key).filter(Boolean))];
    removed.templates = (await BranchTemplate.deleteMany({ ownerId: uid })).deletedCount;
    // ★ 组源视频只在"这一组一段都不剩"时才收：还有别的段（别人做的同组段）就绝不动它，
    //   那是整组的音轨来源。查放在 deleteMany 之后，本人那几段不会把 exists 撑成真。
    for (const key of groupKeys) {
      const left = await BranchTemplate.exists({ "group.key": key });
      if (left) continue;
      const src = templates.find((t) => t.group && t.group.key === key && t.group.sourcePublicId);
      push(src && src.group.sourcePublicId, "video", `group:${key}`);
    }
    if (handles.length) {
      try {
        await PendingAssetPurge.bulkWrite(
          handles.map((h) => ({
            updateOne: { filter: { publicId: h.publicId }, update: { $setOnInsert: h }, upsert: true },
          })),
          { ordered: false }
        );
      } catch (err) {
        // 同 purgeVideo：句柄没落住也不许因此拒绝删号（隐私诉求不该被实现细节挡住）
        if (!err || err.code !== 11000) console.warn("[branch] 模板资产句柄落库失败:", err && (err.message || err));
      }
    }
    removed.templateTrials = (await BranchTemplateTrial.deleteMany({ userId: uid })).deletedCount;
  }

  // ⑧ 举报
  removed.reports = (
    await Report.deleteMany({
      $or: [
        { reporter: uid },
        { targetType: "video", targetId: { $in: videoIds } },
        { targetType: "comment", targetId: { $in: commentIds } },
        { targetType: "danmaku", targetId: { $in: danmakuIds } },
      ],
    })
  ).deletedCount;

  // ⑨ 钱包流水与订单
  removed.tokenLedger = (await TokenLedger.deleteMany({ user: uid })).deletedCount;
  removed.tokenOrders = (await TokenOrder.deleteMany({ user: uid })).deletedCount;

  // ⑩ 关注、通知、搜索记录
  removed.follows = (await Follow.deleteMany({ $or: [{ follower: uid }, { following: uid }] })).deletedCount;
  removed.notifications = (
    await Notification.deleteMany({ $or: [{ userId: uid }, { actorId: uid }] })
  ).deletedCount;
  removed.searchHistory = (await SearchHistory.deleteMany({ user: uid })).deletedCount;

  // ⑪ 用户本体
  removed.user = (await User.deleteOne({ _id: uid })).deletedCount;

  return removed;
}

/**
 * DELETE /api/admin/branch/users/:id —— 硬删账号，**不可逆**，级联清单见 purgeUserCascade。
 *
 * ★ 拒绝删除管理员（403）：删号是全后台威力最大的一个按钮，不设这道闸，
 *   一次手滑（或一个被钓走的管理员账号）就能把全部管理员一锅端 —— 团灭之后
 *   连恢复权限的人都没有了。要删一个管理员：先把他 role 降为 user，再删。
 *   顺带这也挡住了「自己删自己」（自己必是管理员）。
 * ★ UI 侧要求输入用户名做二次确认；服务端不重复收这个字段 —— 确认是交互，
 *   权限与后果才是服务端的事（收了反而多一处「用户名改了导致删不掉」的坑）。
 */
async function deleteUser(req, res, next) {
  try {
    const { id } = req.params;
    const target = await loadTargetUser(id);

    if (isAdmin(target)) forbidden("不能删除管理员账号：要删请先把他的 role 降为 user（防手滑团灭）");

    const removed = await purgeUserCascade(id);

    // 不可逆的越权操作，日志里把删了什么记全（铁律八）
    console.warn(
      `[branchAdmin] 删除账号 user=${id} username=${target.username} admin=${req.user._id} ` +
        `removed=${JSON.stringify(removed)}`
    );

    // 回包带「删了哪些、各多少条」：管理员按下这种按钮后需要看见后果，
    // 一个裸的 ok:true 会让"删了个寂寞"（比如 id 传错删了 0 条）毫无症状
    res.json({ ok: true, removed });
  } catch (err) {
    next(err);
  }
}

// ── 发通知 ───────────────────────────────────────────────────────

/** 通知正文长度上限（1~500 字）。契约值，App 输入框上限必须与它相等 */
const NOTICE_TEXT_MAX = 500;

/**
 * POST /api/admin/branch/users/:id/notify —— 给某个用户发一条平台通知。body: { text 必填 }
 *
 * ★ **不传 actorId**：通知以平台口径发出，「是哪个管理员发的」不透给用户
 *   （理由同 takedown.by —— 审核员不该被摆到被骚扰的位置上）。谁发的记在操作日志里。
 * ★ payload 只有 { text }。deeplink 一个都不带：这类通知就是一句话，App 渲染成
 *   「系统通知」即可（类型契约见 docs/api-contract.md）。
 */
async function notifyUser(req, res, next) {
  try {
    const { id } = req.params;
    const target = await loadTargetUser(id, "_id username");

    const text = String(req.body?.text ?? "").trim();
    if (!text) badRequest("text is required");
    if (text.length > NOTICE_TEXT_MAX) badRequest(`text too long (max ${NOTICE_TEXT_MAX})`);

    const notif = await createNotification({
      userId: target._id,
      type: "ADMIN_NOTICE",
      payload: { text },
    });

    console.warn(
      `[branchAdmin] 发平台通知 user=${id} username=${target.username} admin=${req.user._id} ` +
        `text=${text.slice(0, 60)}`
    );

    res.status(201).json({ ok: true, notificationId: notif?._id || null });
  } catch (err) {
    next(err);
  }
}

// ── 内容钻取（作品 / 评论 / 弹幕的后台列表）─────────────────────────

/**
 * GET /api/admin/branch/videos —— 分页 + 按标题/作者搜 + 按下架状态筛。
 * query：page / limit / q（标题子串，或作者的 username/displayName 子串）/
 *        takenDown（"1" 只看已下架，"0" 只看正常）
 *
 * ★ 这条是**后台**列表，绕过 readableFilter（私密/已下架都列得出来）——
 *   与 assertVisible 给管理员的「按 id 直取」特权同一条理由：审核要看得全。
 *   序列化带 admin:true（takedown.by 给后台看，对作者才藏）。
 */
async function listVideosAdmin(req, res, next) {
  try {
    const { page, limit } = pageParams(req);
    const parts = [];

    const q = String(req.query.q || "").trim();
    if (q) {
      const re = searchRegex(q);
      // 作者按名字搜：先把名字命中的人找出来（吃 author 索引的 $in），
      // 与标题子串取并集 —— 管理员拿到举报时手上常常只有一个名字
      const authors = await User.find({ $or: [{ username: re }, { displayName: re }] })
        .select("_id")
        .limit(50)
        .lean();
      parts.push({ $or: [{ title: re }, { author: { $in: authors.map((u) => u._id) } }] });
    }

    const takenDownRaw = String(req.query.takenDown ?? "").trim();
    if (takenDownRaw === "1") parts.push(TAKEN_DOWN);
    else if (takenDownRaw === "0") parts.push(NOT_TAKEN_DOWN);
    else if (takenDownRaw) badRequest(`Invalid takenDown filter: ${takenDownRaw.slice(0, 20)} (use "1" or "0")`);

    const filter = parts.length ? { $and: parts } : {};

    const [rows, total] = await Promise.all([
      BranchVideo.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", AUTHOR_FIELDS)
        .lean(),
      BranchVideo.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      items: rows.map((doc) => toVideoPayload(doc, { admin: true })),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/branch/comments —— 分页 + 按正文搜 + 按作品筛。
 * query：page / limit / q（正文子串）/ videoId
 * （删除走既有的 DELETE /api/branch/videos/:id/comments/:commentId ——
 *   assertCanDelete 已放行管理员，这里不再开第二条删除路径。）
 */
async function listCommentsAdmin(req, res, next) {
  try {
    const { page, limit } = pageParams(req);
    const parts = [];

    const q = String(req.query.q || "").trim();
    if (q) parts.push({ text: searchRegex(q) });

    const videoId = String(req.query.videoId || "").trim();
    if (videoId) {
      if (!isValidId(videoId)) invalidId("Invalid video id");
      parts.push({ video: new mongoose.Types.ObjectId(videoId) });
    }

    const filter = parts.length ? { $and: parts } : {};

    const [rows, total] = await Promise.all([
      BranchComment.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", AUTHOR_FIELDS)
        .populate("video", "_id title")
        .lean(),
      BranchComment.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      items: rows.map((d) => ({
        _id: d._id,
        text: d.text || "",
        author: d.author || null,
        // 作品可能已被删（评论理论上会级联掉，但坏数据要能显示而不是崩）
        video: d.video ? { _id: d.video._id, title: d.video.title || "" } : null,
        parentId: d.parent ? String(d.parent) : null,
        likes: Number(d.likes || 0),
        createdAt: d.createdAt,
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/branch/danmaku —— 分页 + 按正文搜 + 按作品筛（形状同上）。
 *
 * ★★ 这里带出 author。弹幕对普通用户**从不**透出作者（契约「弹幕」：对外只有
 *   `mine` 布尔），全系统只有两处例外，都在 admin 门后：举报队列的 target、和这条。
 *   哪天要把这条列表放开给非管理员（不该发生），必须先把 author 摘掉，
 *   否则整面弹幕墙被去匿名化。
 */
async function listDanmakuAdmin(req, res, next) {
  try {
    const { page, limit } = pageParams(req);
    const parts = [];

    const q = String(req.query.q || "").trim();
    if (q) parts.push({ text: searchRegex(q) });

    const videoId = String(req.query.videoId || "").trim();
    if (videoId) {
      if (!isValidId(videoId)) invalidId("Invalid video id");
      parts.push({ video: new mongoose.Types.ObjectId(videoId) });
    }

    const filter = parts.length ? { $and: parts } : {};

    const [rows, total] = await Promise.all([
      BranchDanmaku.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", AUTHOR_FIELDS)
        .populate("video", "_id title")
        .lean(),
      BranchDanmaku.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      items: rows.map((d) => ({
        _id: d._id,
        text: d.text || "",
        at: Number(d.at || 0),
        color: d.color || "",
        author: d.author || null, // 仅后台可见，见函数头
        video: d.video ? { _id: d.video._id, title: d.video.title || "" } : null,
        createdAt: d.createdAt,
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listUsers,
  banUser,
  unbanUser,
  deleteUser,
  notifyUser,
  listVideosAdmin,
  listCommentsAdmin,
  listDanmakuAdmin,
  // 导出给测试直接驱动级联（端点之外不该有别的调用方）
  purgeUserCascade,
};
