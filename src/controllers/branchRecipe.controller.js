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

/** 作品文档上那个提示位：与配方表**同拍写**（唯一实现）。flag 为 null = 配方没了，把提示位摘掉 */
async function syncVideoFlag(videoId, flag) {
  if (flag) {
    await BranchVideo.updateOne({ _id: videoId }, { $set: { recipe: { public: flag.public === true, revision: Number(flag.revision || 0) } } });
  } else {
    await BranchVideo.updateOne({ _id: videoId }, { $unset: { recipe: "" } });
  }
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
    updatedAt: doc.updatedAt,
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

    const { recipe, videoRevision, public: isPublic } = req.body;
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
    const doc = await BranchRecipe.findOneAndUpdate(
      { video: video._id },
      {
        $set: { recipe, bytes, nodeCount: recipe.nodes.length, videoRevision: currentRevision, public: isPublic === true },
        $setOnInsert: { owner: req.user._id, video: video._id },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();
    await syncVideoFlag(video._id, { public: doc.public, revision: doc.videoRevision });

    res.json({ ok: true, recipe: toMeta(doc, video) });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/branch/videos/:id/recipe —— 只开 / 关公开（作者本人）。没有配方时 404：打开之前要先 PUT 一份 */
async function patchRecipe(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const video = await BranchVideo.findById(id).select("_id author revision").lean();
    if (!video) notFound("Video not found");
    if (!ownedBy(video, req.user)) forbidden("Forbidden");

    const doc = await BranchRecipe.findOneAndUpdate(
      { video: video._id },
      { $set: { public: req.body.public === true } },
      { returnDocument: "after" }
    ).lean();
    if (!doc) failWith(404, "RECIPE_NOT_FOUND", "这条作品还没有留存制作过程。");
    await syncVideoFlag(video._id, { public: doc.public, revision: doc.videoRevision });

    res.json({ ok: true, recipe: toMeta(doc, video) });
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
      .select("_id title author revision visibility linkOnly takedown")
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

module.exports = { putRecipe, patchRecipe, getRecipe, deleteRecipe };
