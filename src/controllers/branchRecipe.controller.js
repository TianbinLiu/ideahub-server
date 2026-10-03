// src/controllers/branchRecipe.controller.js
// 已发布作品的「公开配方」（制作过程）读 / 写 / 开关 / 删。见 models/BranchRecipe.js 的文件头。
//
// ★ 写（PUT / PATCH / DELETE）只有作者本人；读（GET）是"读得到这条作品的人"里，
//   作者本人恒可读，其余人只在**公开且描述的正是当下这一版**时可读。
// ★ 作品文档上有一个提示位 `BranchVideo.recipe { public, revision }`：列表与详情的回包靠它决定
//   「查看制作过程」亮不亮，不必为每条作品再查一次这张表。**两处同拍写**（syncVideoFlag 一处实现）。
const mongoose = require("mongoose");
const BranchRecipe = require("../models/BranchRecipe");
const BranchVideo = require("../models/BranchVideo");
const BranchCard = require("../models/BranchCard");
const { notFound, forbidden, invalidId, failWith } = require("../utils/http");
const { isAdmin } = require("../utils/roles");
const remixRewardConfig = require("../config/remixReward");
const { summaryFor: remixRewardSummary } = require("../services/remixReward.service");

const AUTHOR_FIELDS = "_id username displayName avatarUrl uid";

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function isTakenDown(doc) {
  return !!(doc && doc.takedown && doc.takedown.at);
}

function ownedBy(doc, user) {
  if (!doc || !user) return false;
  const author = doc.author && doc.author._id ? doc.author._id : doc.author;
  return String(author) === String(user._id);
}

/**
 * 这条作品这个人读不读得到 —— 与 branchVideo.controller 的 `readableBy` **同一条规则**
 * （按 id 直取的口径：作者 / 管理员恒可读；下架的对别人不可读；私密的只有「凭链接可见」放行）。
 * ★ 抄在这里而不是 require 那边：那个文件 2600 行、导出面是端点处理器，反向引它会把两个 controller 绕在一起。
 *   规则变了两处一起改 —— tests/branchRecipe.spec.js 里把私密 / 凭链接 / 下架三档各钉了一条，改漏了会红。
 */
function videoReadableBy(doc, user) {
  if (ownedBy(doc, user) || isAdmin(user)) return true;
  if (isTakenDown(doc)) return false;
  if (doc.visibility === "private" && doc.linkOnly === true) return true;
  return doc.visibility !== "private";
}

/**
 * **列表**口径的可读条件（Mongo 版）—— 与 branchVideo.controller 的 `readableByIdFilter` 同一条规则
 * （认「凭链接可见」：主人拍板工作流模板必须挂在已发布作品上，"不想进首页流就设成凭链接可见"，
 *   所以货架上**要**收凭链接可见的作品；私密的、下架的不收）。抄在这里的理由同 videoReadableBy。
 */
function videoReadableFilter(user) {
  const open = {
    $or: [{ visibility: { $ne: "private" } }, { visibility: "private", linkOnly: true }],
    "takedown.at": { $exists: false },
  };
  return user ? { $or: [open, { author: user._id }] } : open;
}

/** 作品文档上那个提示位：与配方表**同拍写**（唯一实现）。flag 为 null = 配方没了，把提示位摘掉 */
async function syncVideoFlag(videoId, flag) {
  if (flag) {
    await BranchVideo.updateOne(
      { _id: videoId },
      { $set: { recipe: { public: flag.public === true, revision: Number(flag.revision || 0), listed: flag.listed === true } } }
    );
  } else {
    await BranchVideo.updateOne({ _id: videoId }, { $unset: { recipe: "" } });
  }
}

function flagOf(doc) {
  return { public: doc.public, revision: doc.videoRevision, listed: doc.listed };
}

/**
 * 第二道红线：配方里带出去的卡，按**作者自己的卡库**再核一遍。
 *   · 真人卡（BranchCard.realPerson）—— 形象图是一个真实的人的照片，不许公开；
 *   · 从别人那儿装来的卡（BranchCard.sourceOwner）—— 转发件不许再分享（与卡片 / 卡组上广场同一条规则）。
 * 客户端的投影本来就该把这两种变成空位（recipe.cast）；这里不信它。
 * ★ 卡库里查不到的卡（随片派生的、从别人作品的卡组里挂来的）不拦：那些要么是这条作品自己的产物，
 *   要么本来就是公开作品上的公开卡组。能核的只有"它在我库里时是什么"。
 */
async function assertShareableCards(owner, recipe) {
  const ids = (recipe.deck || []).map((c) => c.cardId);
  if (!ids.length) return;
  const bad = await BranchCard.find({ owner, cardId: { $in: ids }, $or: [{ realPerson: true }, { sourceOwner: { $exists: true, $ne: null } }] })
    .select("cardId realPerson sourceOwner")
    .lean();
  if (!bad.length) return;
  if (bad.some((c) => c.realPerson === true)) {
    failWith(400, "RECIPE_REAL_PERSON", "制作过程里带着真人卡 —— 真人卡不能公开。这一版没有公开。");
  }
  failWith(400, "RECIPE_FOREIGN_CARD", "制作过程里带着从别人那儿装来的卡 —— 装来的卡不能再分享出去。这一版没有公开。");
}

function toMeta(doc, video) {
  const currentRevision = Number((video && video.revision) || 0);
  return {
    video: doc.video,
    videoRevision: Number(doc.videoRevision || 0),
    public: doc.public === true,
    // 配方描述的不是作品当下这一版（回炉之后还没换上新的）：对别人不可见，作者自己看得到这一位
    stale: Number(doc.videoRevision || 0) !== currentRevision,
    bytes: Number(doc.bytes || 0),
    nodeCount: Number(doc.nodeCount || 0),
    // 上架到了模板市场（工作流模板）。对别人可见的条件与配方相同（listWorkflowTemplates 再过一遍）
    listed: doc.listed === true,
    updatedAt: doc.updatedAt,
  };
}

/**
 * 货架上那张卡要的摘要（段数 / 总时长 / 用到的档位 / 用了模板的段数 / 卡 / 空位）—— 服务端从正文里数，
 * 列表不必把几十份正文整个发下去。与 App 的 data/recipe.recipeSummary 同一个口径。
 */
function summaryOf(recipe) {
  const nodes = Array.isArray(recipe && recipe.nodes) ? recipe.nodes : [];
  const tiers = [];
  for (const n of nodes) if (n && typeof n.tier === "string" && !tiers.includes(n.tier)) tiers.push(n.tier);
  return {
    segs: nodes.length,
    totalSec: Math.round(nodes.reduce((s, n) => s + (Number(n && n.durationSec) || 0), 0)),
    tiers,
    templated: nodes.filter((n) => n && n.kind === "blockout").length,
    cards: Array.isArray(recipe && recipe.deck) ? recipe.deck.length : 0,
    slots: Array.isArray(recipe && recipe.cast) ? recipe.cast.length : 0,
  };
}

/**
 * PUT /api/branch/videos/:id/recipe —— 留存 / 覆盖这条作品的公开配方（作者本人）。
 *
 * ★ `videoRevision` 必须等于作品当下的 revision（400 RECIPE_REVISION_MISMATCH）：
 *   放行的话，回炉之后一份上一版的制作过程会顶着这一版的名义公开 —— 别人照着它做同款，做出来的不是眼前这条片。
 * ★ 存的是 `req.body.recipe` —— validate 中间件已经把它换成了 zod **解析之后**的对象（白名单之外的键剥掉了）。
 */
async function putRecipe(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const video = await BranchVideo.findById(id).select("_id author revision").lean();
    if (!video) notFound("Video not found");
    if (!ownedBy(video, req.user)) forbidden("Forbidden");

    const { recipe, videoRevision, public: isPublic, listed: wantListed } = req.body;
    const currentRevision = Number(video.revision || 0);
    if (Number(videoRevision) !== currentRevision) {
      failWith(
        400,
        "RECIPE_REVISION_MISMATCH",
        `这份制作过程描述的是第 ${Number(videoRevision) + 1} 版，而这条作品在服务器上已经是第 ${currentRevision + 1} 版了 —— 这一版的制作过程没有公开。`,
        { currentRevision }
      );
    }
    await assertShareableCards(req.user._id, recipe);

    const bytes = Buffer.byteLength(JSON.stringify(recipe));
    // 上架位：只有公开着才能挂在货架上。发布页勾了「同时上架」而没勾公开 = 不上架（不报错：开关本来就是从属的）。
    //   没勾上架时**不动**原来的 listed（回炉重投一份配方不该把作者上过的架悄悄撤掉）；关公开则一并下架。
    const prev = await BranchRecipe.findOne({ video: video._id }).select("listed listedAt").lean();
    const listed = isPublic === true && (wantListed === true || (prev && prev.listed === true));
    const doc = await BranchRecipe.findOneAndUpdate(
      { video: video._id },
      {
        $set: {
          recipe,
          bytes,
          nodeCount: recipe.nodes.length,
          videoRevision: currentRevision,
          public: isPublic === true,
          listed,
          ...(listed && !(prev && prev.listed) ? { listedAt: new Date() } : {}),
        },
        $setOnInsert: { owner: req.user._id, video: video._id },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();
    await syncVideoFlag(video._id, flagOf(doc));

    res.json({ ok: true, recipe: toMeta(doc, video) });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/branch/videos/:id/recipe —— 开 / 关公开，上 / 下架模板市场（作者本人）。没有配方时 404：打开之前要先 PUT 一份。
 * ★ 上架的前提是「公开 + 不过期」（400 RECIPE_NOT_LISTABLE）：货架上不能挂一份别人点进去 404 的东西；
 *   关公开时顺手下架（同一拍、同一条规则的两个方向）。
 */
async function patchRecipe(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const video = await BranchVideo.findById(id).select("_id author revision").lean();
    if (!video) notFound("Video not found");
    if (!ownedBy(video, req.user)) forbidden("Forbidden");

    const cur = await BranchRecipe.findOne({ video: video._id }).lean();
    if (!cur) failWith(404, "RECIPE_NOT_FOUND", "这条作品还没有留存制作过程。");
    const nextPublic = req.body.public === undefined ? cur.public === true : req.body.public === true;
    let nextListed = req.body.listed === undefined ? cur.listed === true : req.body.listed === true;
    // 明确要上架（而不是原来就上着）时把关：没公开 / 过期的整句拒 —— 静默不上架的话作者以为上了（CLAUDE.md「看着生效、实际什么都没做的开关」）
    if (req.body.listed === true && !(cur.listed === true)) {
      const stale = Number(cur.videoRevision || 0) !== Number(video.revision || 0);
      if (!nextPublic || stale) {
        failWith(
          400,
          "RECIPE_NOT_LISTABLE",
          stale ? "留存的制作过程还是上一版的，先用这一版重新公开，再上架。" : "制作过程没有公开，不能上架到模板市场。"
        );
      }
    }
    // 关公开顺手下架（同一拍、同一条规则的两个方向）
    if (!nextPublic) nextListed = false;
    const doc = await BranchRecipe.findOneAndUpdate(
      { video: video._id },
      { $set: { public: nextPublic, listed: nextListed, ...(nextListed && !(cur.listed === true) ? { listedAt: new Date() } : {}) } },
      { returnDocument: "after" }
    ).lean();
    await syncVideoFlag(video._id, flagOf(doc));

    res.json({ ok: true, recipe: toMeta(doc, video) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/branch/templates/workflows —— 模板市场的「工作流」货架：上了架、公开着、描述的正是当下这一版、
 * 作品对这个人可读（列表口径，收凭链接可见）的配方，按上架时间倒序。query `limit`（默认 30，上限 60）、
 * `before`（上一页最后一条的 listedAt，ISO）。不带正文，只带货架要的摘要。
 */
async function listWorkflowTemplates(req, res, next) {
  try {
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    const q = { listed: true, public: true, ...(before && !Number.isNaN(before.getTime()) ? { listedAt: { $lt: before } } : {}) };
    // 多取一倍再按作品可读性筛：被筛掉的（私密 / 下架 / 回炉后过期）不占名额
    const docs = await BranchRecipe.find(q).sort({ listedAt: -1 }).limit(limit * 2).lean();
    if (!docs.length) return res.json({ ok: true, items: [] });
    const videos = await BranchVideo.find({ _id: { $in: docs.map((d) => d.video) }, ...videoReadableFilter(req.user) })
      .select("_id title cover author revision createdAt")
      .populate("author", AUTHOR_FIELDS)
      .lean();
    const byId = new Map(videos.map((v) => [String(v._id), v]));
    const ids = videos.map((v) => v._id);
    // 「有几个人按它做了同款」一次聚合（不含作者自己）
    const counts = ids.length
      ? await BranchVideo.aggregate([
          { $match: { "remixOf.video": { $in: ids }, "takedown.at": { $exists: false } } },
          { $group: { _id: "$remixOf.video", n: { $sum: 1 }, self: { $sum: { $cond: [{ $eq: ["$author", "$remixOf.author"] }, 1, 0] } } } },
        ])
      : [];
    const remixBy = new Map(counts.map((c) => [String(c._id), Math.max(0, c.n - c.self)]));
    const items = [];
    for (const d of docs) {
      const v = byId.get(String(d.video));
      if (!v) continue;
      if (Number(d.videoRevision || 0) !== Number(v.revision || 0)) continue; // 回炉后过期的不上货架
      const a = v.author || {};
      items.push({
        video: v._id,
        title: v.title || "",
        cover: v.cover || "",
        author: { _id: a._id, username: a.username || "", displayName: a.displayName || a.username || "", avatarUrl: a.avatarUrl || "" },
        summary: summaryOf(d.recipe),
        remixCount: remixBy.get(String(v._id)) || 0,
        listedAt: d.listedAt || d.updatedAt,
        updatedAt: d.updatedAt,
      });
      if (items.length >= limit) break;
    }
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/branch/videos/:id/recipe —— 看制作过程。
 *
 * ★ 先过作品本身的可读闸（读不到这条作品的人一律 404，不泄漏"这个 id 上有东西"）。
 * ★ 作者本人恒可读（编辑页要看"现在公开的是什么"）；别人只在**公开**且**描述的正是当下这一版**时可读 ——
 *   两种不可读对别人是同一个 404 RECIPE_NOT_PUBLIC（没必要告诉别人"作者留了一份但关着"）。
 */
async function getRecipe(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const video = await BranchVideo.findById(id)
      .select("_id title cover author revision visibility linkOnly takedown")
      .populate("author", AUTHOR_FIELDS)
      .lean();
    if (!video) notFound("Video not found");
    if (!videoReadableBy(video, req.user)) notFound("Video not found");

    const doc = await BranchRecipe.findOne({ video: video._id }).lean();
    const mine = ownedBy(video, req.user);
    if (!doc) failWith(404, mine ? "RECIPE_NOT_FOUND" : "RECIPE_NOT_PUBLIC", mine ? "这条作品还没有留存制作过程。" : "这条作品没有公开制作过程。");
    const meta = toMeta(doc, video);
    if (!mine && (!meta.public || meta.stale)) failWith(404, "RECIPE_NOT_PUBLIC", "这条作品没有公开制作过程。");

    const a = video.author || {};
    res.json({
      ok: true,
      recipe: doc.recipe,
      meta: {
        ...meta,
        title: video.title || "",
        // 示例视频的封面：制作过程页顶上那张图（工作流模板的模板页就是这一页）
        cover: video.cover || "",
        author: { _id: a._id, username: a.username || "", displayName: a.displayName || a.username || "", avatarUrl: a.avatarUrl || "" },
        isOwner: mine,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/branch/videos/:id/recipe —— 作者把留存的制作过程整个删掉（作品本身不受影响） */
async function deleteRecipe(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const video = await BranchVideo.findById(id).select("_id author").lean();
    if (!video) notFound("Video not found");
    if (!ownedBy(video, req.user)) forbidden("Forbidden");

    await BranchRecipe.deleteOne({ video: video._id });
    await syncVideoFlag(video._id, null);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// GET /api/branch/remix-reward
/**
 * 同款奖励的规则 + 登录者自己（作为原作者）的小结。
 * ★ 规则那一份是 App 上那句「每次 N token、每天最多 M 次…」的**唯一出处**：App 不另抄数（config/remixReward 的 ★）。
 * ★ 没登录也回规则（规则与谁在问无关）；`mine` 只在登录时带。
 */
async function getRemixReward(req, res, next) {
  try {
    const reward = remixRewardConfig.publicConfig();
    const mine = req.user ? await remixRewardSummary(req.user._id) : null;
    res.json({ ok: true, reward, ...(mine ? { mine } : {}) });
  } catch (err) {
    next(err);
  }
}

module.exports = { putRecipe, patchRecipe, getRecipe, deleteRecipe, listWorkflowTemplates, getRemixReward };
