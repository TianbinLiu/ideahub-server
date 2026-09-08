// src/controllers/branchProject.controller.js
// 已发布作品的「工坊工程」（画布快照）读/写/删。见 models/BranchProject.js 的文件头。
//
// ★ 四条端点全部 requireAuth，且**只有作者本人**能碰：
//   写入判「这条作品是不是你的」（作品可能已被删 → 404），
//   读/删判「这份工程是不是你的」（工程的 owner 就是当时的作者）。
// ★ 服务端是**真相**，客户端本地只是缓存（App 侧 data/projects.ts 的 ★★ 写着为什么：
//   本地草稿箱按 updatedAt 只留 20 条，工程的 updatedAt 冻结在发布那一刻，
//   一定先被挤掉 —— 那就是"功能看着在、实际不生效、零提示"）。
const mongoose = require("mongoose");
const BranchProject = require("../models/BranchProject");
const BranchVideo = require("../models/BranchVideo");
const { notFound, forbidden, invalidId, failWith } = require("../utils/http");
const {
  PROJECT_MAX_COUNT,
  PROJECT_MAX_TOTAL_BYTES,
} = require("../schemas/branchProject.schemas");

/** 「我的工程」列表一次最多回多少条。★ 只回元信息，**绝不回 canvas**（见 listProjects）。 */
const PROJECT_LIST_MAX = 200;

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

/**
 * PUT /api/branch/projects/by-video/:videoId —— 留存/覆盖这条作品的工坊工程。
 *
 * ★ upsert：第一次是留存，回炉成功后再 PUT 一次是覆盖。**必须覆盖**——
 *   不覆盖的话第二次点「回炉重做」载入的是**第一版**的画布，作者这一轮的改动无声消失；
 *   他就着那份旧画布再提交一次，线上作品会被静默回滚到第一版。
 * ★ `bytes` 与 `owner` 都是服务端自己算/自己填的，客户端报的数一律不信
 *   （配额是拿它算的，信客户端等于配额不存在）。
 *
 * ★★ `videoRevision` 必须**等于作品当下的 revision**，否则 400（2026-09-07 评审补）。
 *   这是 `BranchProject.videoRevision` 那条 ★★ 的第①条纪律：这一格只能靠这条路往前走。
 *   放行的表现是库里留下「canvas 是第 1 版正文 / videoRevision 写着 2」这种自相矛盾的行，
 *   之后谁也看不出它陈旧了 —— 而下一次回炉就着它提交，线上内容被**静默退回**。
 *   可达路径：A 机回炉成功（rev→1）后 PUT 在途，B 机又回炉成功（rev→2），A 那发 PUT 才落地。
 */
async function putProject(req, res, next) {
  try {
    const { videoId } = req.params;
    if (!isValidId(videoId)) invalidId("Invalid video id");

    // 作品必须存在且是你的。★ 先验作品再验配额：作品都不是你的，配额是多少都不该告诉你。
    const video = await BranchVideo.findById(videoId).select("_id author revision").lean();
    if (!video) notFound("Video not found");
    if (String(video.author) !== String(req.user._id)) forbidden("Forbidden");

    const { title, canvas, videoRevision, lostCount } = req.body;

    // ★★ 版次闸（见本函数头的 ★★）。判否定：老作品没有 revision 字段 = 第 0 版。
    const currentRevision = Number(video.revision || 0);
    if (Number(videoRevision) !== currentRevision) {
      console.warn("[project] 版次对不上，拒收", {
        videoId: String(videoId),
        code: "PROJECT_REVISION_MISMATCH",
        got: Number(videoRevision),
        current: currentRevision,
      });
      failWith(
        400,
        "PROJECT_REVISION_MISMATCH",
        `这份工程描述的是第 ${Number(videoRevision) + 1} 版，而这条作品在服务器上已经是第 ${currentRevision + 1} 版了 —— 这一版没有留存。`,
        { currentRevision }
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(canvas ?? null));

    // 配额：**排除这条作品自己已有的那份**（覆盖不该被自己的旧体积挡住）。
    // ⛔ 不做自动淘汰：那是替用户删他自己的东西。超了就整句拒，让他自己去删。
    const owner = req.user._id;
    const [otherCount, agg] = await Promise.all([
      BranchProject.countDocuments({ owner, video: { $ne: video._id } }),
      BranchProject.aggregate([
        { $match: { owner: new mongoose.Types.ObjectId(String(owner)), video: { $ne: video._id } } },
        { $group: { _id: null, sum: { $sum: "$bytes" } } },
      ]),
    ]);
    const otherBytes = (agg && agg[0] && agg[0].sum) || 0;
    if (otherCount + 1 > PROJECT_MAX_COUNT || otherBytes + bytes > PROJECT_MAX_TOTAL_BYTES) {
      console.warn("[project] 拒收", {
        userId: String(owner),
        code: "PROJECT_QUOTA",
        bytes,
        otherCount,
        otherBytes,
      });
      failWith(
        400,
        "PROJECT_QUOTA",
        "留存的工坊工程已达上限（100 条 / 50MB）。到较早那些作品的编辑页删掉几条工程，再点「重试留存」。"
      );
    }

    const doc = await BranchProject.findOneAndUpdate(
      { video: video._id },
      {
        // ★ `stale: false`：这一发 PUT 正是"画布换成了当下这一版"的那个动作
        //   （回炉成功时服务端把它置真，见 branchVideo.controller 的第 ⑧ 步）
        $set: { title: title || "", canvas, bytes, videoRevision, lostCount, stale: false },
        // ★ owner 只在插入时写：换个人来 PUT 已经被上面那道作者判定挡住了，
        //   而 $set 一个 owner 等于给"作品转移"预留一个我们并不支持的语义
        $setOnInsert: { owner, video: video._id },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();

    res.json({
      ok: true,
      project: {
        video: doc.video,
        title: doc.title || "",
        bytes: doc.bytes || 0,
        videoRevision: Number(doc.videoRevision || 0),
        stale: doc.stale === true,
        lostCount: Number(doc.lostCount || 0),
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/branch/projects/by-video/:videoId —— 取回画布（回炉时用）。
 * ★ 没有工程时 404 + `PROJECT_NOT_FOUND` + 一句人话：客户端据此把「🛠 回炉重做」
 *   画成灰键并说清原因，而不是摆一个没有原因的灰（那会被读成"功能没上线"）。
 */
async function getProject(req, res, next) {
  try {
    const { videoId } = req.params;
    if (!isValidId(videoId)) invalidId("Invalid video id");

    const doc = await BranchProject.findOne({ video: videoId }).lean();
    if (!doc) failWith(404, "PROJECT_NOT_FOUND", "这条作品没有留存工坊工程。");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");

    res.json({
      ok: true,
      project: {
        video: doc.video,
        title: doc.title || "",
        canvas: doc.canvas,
        // ★ 客户端拿这两格与作品当下的 revision 比：对不上就**不许铺进工坊**
        //   （见 models/BranchProject.js 的 videoRevision ★★ 第②条）
        videoRevision: Number(doc.videoRevision || 0),
        stale: doc.stale === true,
        lostCount: Number(doc.lostCount || 0),
        updatedAt: doc.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/branch/projects/by-video/:videoId —— 用户主动放弃留存（作品本身不受影响） */
async function deleteProject(req, res, next) {
  try {
    const { videoId } = req.params;
    if (!isValidId(videoId)) invalidId("Invalid video id");

    const doc = await BranchProject.findOne({ video: videoId }).select("_id owner").lean();
    if (!doc) failWith(404, "PROJECT_NOT_FOUND", "这条作品没有留存工坊工程。");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");

    await BranchProject.deleteOne({ _id: doc._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/branch/projects —— 我留存了哪些工程（编辑页那颗按钮灰不灰就看它）。
 *
 * ⛔ **绝不回 canvas**：这是"有没有"的问题，不是"内容是什么"的问题。
 *   把 200 份 20–400KB 的画布一次性回给客户端，等于每次进个人页就下载几十 MB，
 *   而调用方一个字节都用不上。
 */
async function listProjects(req, res, next) {
  try {
    const items = await BranchProject.find({ owner: req.user._id })
      .select("video title bytes videoRevision stale lostCount updatedAt")
      .sort({ updatedAt: -1 })
      .limit(PROJECT_LIST_MAX)
      .lean();

    res.json({
      ok: true,
      items: items.map((d) => ({
        video: d.video,
        title: d.title || "",
        bytes: Number(d.bytes || 0),
        videoRevision: Number(d.videoRevision || 0),
        stale: d.stale === true,
        lostCount: Number(d.lostCount || 0),
        updatedAt: d.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { putProject, getProject, deleteProject, listProjects, PROJECT_LIST_MAX };
