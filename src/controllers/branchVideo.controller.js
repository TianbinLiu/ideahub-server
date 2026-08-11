// src/controllers/branchVideo.controller.js
// 分支视频控制器：列表（recommend/following + category + q + cursor 分页）、发布（含资源转存）、
// 详情、删除、播放计数、点赞/取消（BranchLike 去重）、评论列表/发表。
//
// ★ 资源转存（契约 docs/api-contract.md「资源转存」）：
//   1) dataURL   → Buffer → uploadToCloudinary(buffer, "branch-frames", key)
//   2) 方舟 TOS videoUrl（约 24h 过期）→ 服务端 fetch 下载 → cloudinary upload_stream({resource_type:"video"})
//   3) 其它 http(s) 外链 → 原样保留
//   单个资源失败只 console.warn 并降级为原值，不阻断整条发布。
const mongoose = require("mongoose");
const BranchVideo = require("../models/BranchVideo");
const BranchLike = require("../models/BranchLike");
const BranchComment = require("../models/BranchComment");
const BranchDanmaku = require("../models/BranchDanmaku");
const Follow = require("../models/Follow");
const { uploadToCloudinary } = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const { listQuery, commentListQuery, danmakuListQuery } = require("../schemas/branchVideo.schemas");

const AUTHOR_FIELDS = "_id username displayName avatarUrl";

// 下载方舟视频的上限与超时（可用环境变量覆盖）
const MAX_VIDEO_BYTES = Number(process.env.BRANCH_VIDEO_MAX_BYTES || 80 * 1024 * 1024);
const VIDEO_FETCH_TIMEOUT_MS = Number(process.env.BRANCH_VIDEO_FETCH_TIMEOUT_MS || 60_000);
// 转存失败时，超过该长度的 dataURL 不再内联落库（否则一条作品的 base64 会撑爆 16MB BSON 上限）
const MAX_INLINE_FALLBACK = Number(process.env.BRANCH_INLINE_FALLBACK_MAX || 512 * 1024);

// 火山方舟 / TOS 视频域名特征：命中则必须转存，否则 24h 后链接失效
const ARK_HOST_PATTERNS = [
  /(^|\.)volces\.com$/i,
  /(^|\.)volccdn\.com$/i,
  /(^|\.)byteimg\.com$/i,
  /(^|\.)bytedance\.com$/i,
  /(^|\.)ivolces\.com$/i,
  /tos-[a-z0-9-]+\./i,
];

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDataUrl(value) {
  return typeof value === "string" && /^data:[\w.+-]*\/?[\w.+-]*;base64,/i.test(value.trim());
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function isArkVideoUrl(value) {
  if (!isHttpUrl(value)) return false;
  try {
    const host = new URL(value.trim()).hostname;
    return ARK_HOST_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

// ── 资源转存 ─────────────────────────────────────────────────────

function dataUrlToBuffer(value) {
  const raw = String(value).trim();
  const commaAt = raw.indexOf(",");
  if (commaAt < 0) return null;
  const buf = Buffer.from(raw.slice(commaAt + 1), "base64");
  return buf.length ? buf : null;
}

/** 转存失败的降级值：过大的 dataURL 不内联落库，避免撑爆单文档 16MB */
function fallbackValue(original, label) {
  const raw = String(original || "");
  if (isDataUrl(raw) && raw.length > MAX_INLINE_FALLBACK) {
    console.warn(`[branch] ${label} 转存失败且 dataURL 过大(${raw.length}B)，已丢弃内联数据`);
    return "";
  }
  return raw;
}

async function uploadVideoBuffer(buffer, key) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "ideahub/branch-videos",
        public_id: `${key}`,
        resource_type: "video",
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result?.secure_url || "");
      }
    );
    stream.end(buffer);
  });
}

async function downloadToBuffer(url) {
  if (typeof fetch !== "function") throw new Error("global fetch unavailable (Node >= 18 required)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const declared = Number(resp.headers.get("content-length") || 0);
    if (declared && declared > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${declared} > ${MAX_VIDEO_BYTES}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error("empty body");
    if (buf.length > MAX_VIDEO_BYTES) {
      throw new Error(`video too large: ${buf.length} > ${MAX_VIDEO_BYTES}`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 转存上下文：同一次发布内按「原始值」缓存结果，
 * 让 segments 与 branchTree 里重复出现的同一帧只上传一次。
 */
function createTransferContext(userId) {
  return { userId, cache: new Map(), seq: 0, uploaded: 0, failed: 0, kept: 0 };
}

function nextKey(ctx, label) {
  ctx.seq += 1;
  const slug = String(label).replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 24);
  return `${ctx.userId}-${Date.now()}-${ctx.seq}-${slug}`;
}

/** 图片类资源（cover / firstFrame / lastFrame）：dataURL 才转存，http(s) 原样保留 */
async function transferImage(ctx, value, label) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!isDataUrl(raw)) {
    ctx.kept += 1;
    return raw; // 已是 http(s) 或其它形式，原样保留
  }
  if (ctx.cache.has(raw)) return ctx.cache.get(raw);

  let out;
  try {
    const buffer = dataUrlToBuffer(raw);
    if (!buffer) throw new Error("invalid dataURL payload");
    out = await uploadToCloudinary(buffer, "branch-frames", nextKey(ctx, label));
    ctx.uploaded += 1;
  } catch (err) {
    ctx.failed += 1;
    console.warn(`[branch] 图片转存失败(${label}):`, err?.message || err);
    out = fallbackValue(raw, label);
  }
  ctx.cache.set(raw, out);
  return out;
}

/** 视频资源：dataURL 或方舟 TOS 链接才转存，其它 http(s) 原样保留 */
async function transferVideo(ctx, value, label) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const needsTransfer = isDataUrl(raw) || isArkVideoUrl(raw);
  if (!needsTransfer) {
    ctx.kept += 1;
    return raw;
  }
  if (ctx.cache.has(raw)) return ctx.cache.get(raw);

  let out;
  try {
    const buffer = isDataUrl(raw) ? dataUrlToBuffer(raw) : await downloadToBuffer(raw);
    if (!buffer) throw new Error("empty video payload");
    out = await uploadVideoBuffer(buffer, nextKey(ctx, label));
    if (!out) throw new Error("cloudinary returned no url");
    ctx.uploaded += 1;
  } catch (err) {
    ctx.failed += 1;
    console.warn(`[branch] 视频转存失败(${label}):`, err?.message || err);
    out = fallbackValue(raw, label); // 降级保留原值（方舟链接约 24h 后失效）
  }
  ctx.cache.set(raw, out);
  return out;
}

/**
 * ★ 这里是逐字段重建，不是展开原对象 —— 所以它是**第二个会悄悄丢字段的地方**
 *   （第一个是 schemas/branchVideo.schemas.js 的 z.object strip）。
 *   给 segment 加字段时**两处都要加**，只加一处的表现完全一样：201 成功、读回来没有。
 *   故意不写成 `{ ...segment, firstFrame: ... }`：那样会把客户端塞的任意字段
 *   一并落库，模型里没有的会被 mongoose 丢掉、有的又绕过了校验。
 */
async function transferSegment(ctx, segment, label) {
  return {
    title: segment.title || "",
    plot: segment.plot || "",
    firstFrame: await transferImage(ctx, segment.firstFrame, `${label}.firstFrame`),
    lastFrame: await transferImage(ctx, segment.lastFrame, `${label}.lastFrame`),
    durationSec: Number(segment.durationSec || 0),
    videoUrl: await transferVideo(ctx, segment.videoUrl, `${label}.videoUrl`),
    ...(segment.videoTier ? { videoTier: segment.videoTier } : {}),
    ...(segment.aspect ? { aspect: segment.aspect } : {}),
  };
}

/**
 * 把整份草稿里的外链资源转存到 Cloudinary。
 * 串行执行：Cloudinary 有并发/速率限制，且缓存命中依赖前一次结果。
 */
async function transferDraftAssets(draft, userId) {
  const ctx = createTransferContext(userId);

  const cover = await transferImage(ctx, draft.cover, "cover");

  const segments = [];
  for (let i = 0; i < draft.segments.length; i += 1) {
    segments.push(await transferSegment(ctx, draft.segments[i], `segments[${i}]`));
  }

  // 卡组快照的卡面同样可能是 dataURL。
  // ★ app 端 publishAssets.materializeDraft 现在会先把它们传成 URL 再发，
  //   但这条路必须留着：老版本 app、以及别的客户端仍会直接发 base64。
  let deck;
  if (draft.deck && Array.isArray(draft.deck.cards)) {
    const cards = [];
    for (let i = 0; i < draft.deck.cards.length; i += 1) {
      const c = draft.deck.cards[i];
      cards.push({
        cardId: String(c.cardId || c.id || ""),
        type: c.type || "prop",
        name: c.name || "",
        summary: c.summary || "",
        cover: await transferImage(ctx, c.cover, `deck.cards[${i}]`),
        tags: Array.isArray(c.tags) ? c.tags : [],
      });
    }
    deck = { name: draft.deck.name || "", cards };
  }

  let branchTree;
  if (draft.branchTree && draft.branchTree.nodes) {
    const nodes = {};
    for (const [nodeId, node] of Object.entries(draft.branchTree.nodes)) {
      nodes[nodeId] = {
        id: node.id || nodeId,
        segment: await transferSegment(ctx, node.segment, `branchTree.${nodeId}`),
        choices: Array.isArray(node.choices) ? node.choices : [],
      };
    }
    branchTree = {
      rootId: draft.branchTree.rootId,
      ...(draft.branchTree.startChoices ? { startChoices: draft.branchTree.startChoices } : {}),
      nodes,
    };
  }

  console.log(
    `[branch] 资源转存完成 user=${userId} uploaded=${ctx.uploaded} kept=${ctx.kept} failed=${ctx.failed}`
  );

  return { cover, segments, branchTree, deck };
}

// ── 序列化 ───────────────────────────────────────────────────────

function toAuthorPayload(author) {
  if (!author) return null;
  if (typeof author === "object" && author._id) {
    return {
      _id: author._id,
      username: author.username || "",
      displayName: author.displayName || "",
      avatarUrl: author.avatarUrl || "",
    };
  }
  return author; // 未 populate 时是裸 ObjectId
}

function toBranchTreePayload(tree) {
  if (!tree) return undefined;
  // lean() 出来的 Map 字段是普通对象；非 lean 时是 Map
  const nodes = tree.nodes instanceof Map ? Object.fromEntries(tree.nodes) : tree.nodes;
  if (!nodes) return undefined;
  return {
    rootId: tree.rootId || "",
    ...(Array.isArray(tree.startChoices) && tree.startChoices.length
      ? { startChoices: tree.startChoices }
      : {}),
    nodes,
  };
}

function toVideoPayload(doc, ctx = {}) {
  if (!doc) return null;
  const payload = {
    _id: doc._id,
    title: doc.title || "",
    category: doc.category || "",
    description: doc.description || "",
    cover: doc.cover || "",
    segments: Array.isArray(doc.segments) ? doc.segments : [],
    author: toAuthorPayload(doc.author),
    plays: Number(doc.plays || 0),
    likes: Number(doc.likes || 0),
    commentCount: Number(doc.commentCount || 0),
    // 老数据没这个字段，对外一律归一成 "public"（客户端就不用再判 undefined）
    visibility: doc.visibility === "private" ? "private" : "public",
    liked: !!ctx.liked,
    isOwner: !!ctx.isOwner,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  const tree = toBranchTreePayload(doc.branchTree);
  if (tree) payload.branchTree = tree;
  if (doc.deck && Array.isArray(doc.deck.cards) && doc.deck.cards.length) payload.deck = doc.deck;
  if (doc.pricing && doc.pricing.mode === "paid") payload.pricing = doc.pricing;
  if (ctx.comments) payload.comments = ctx.comments;
  return payload;
}

function toCommentPayload(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: toAuthorPayload(doc.author),
    text: doc.text || "",
    createdAt: doc.createdAt,
  };
}

function ownedBy(doc, user) {
  return !!user && !!doc?.author && String(user._id) === String(doc.author?._id || doc.author);
}

/**
 * 仅自己可见的作品：除作者本人外谁都不该看到。
 *
 * ★ 用 `!== "private"` 判而不是 `=== "public"`：字段是后加的，**存量作品这一项是
 *   undefined**，按等值判会把库里所有老作品判成不可见（表现是首页突然空了）。
 *   同一条规则在 listVideos 的 Mongo 查询里是 `{ visibility: { $ne: "private" } }`
 *   ——改一处必须改另一处（铁律六）。
 */
function visibleTo(doc, user) {
  return doc?.visibility !== "private" || ownedBy(doc, user);
}

/** 列表用的可见性条件：公开的 + 自己的（未登录就只有公开的） */
function visibilityFilter(user) {
  const open = { visibility: { $ne: "private" } };
  return user ? { $or: [open, { author: user._id }] } : open;
}

/** 当前用户在这批视频里点过赞的集合 */
async function loadLikedSet(user, docs) {
  if (!user || !docs.length) return new Set();
  const likes = await BranchLike.find({
    user: user._id,
    video: { $in: docs.map((d) => d._id) },
  })
    .select("video")
    .lean();
  return new Set(likes.map((x) => String(x.video)));
}

// ── cursor 分页（createdAt 降序 + _id 兜底，避免同毫秒丢条目）────

function encodeCursor(doc) {
  const at = doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt);
  return `${at.toISOString()}_${doc._id}`;
}

function cursorFilter(cursor) {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf("_");
  if (sep < 0) return null;
  const at = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(at.getTime()) || !isValidId(id)) return null;
  return {
    $or: [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: new mongoose.Types.ObjectId(id) } }],
  };
}

// ── 端点 ─────────────────────────────────────────────────────────

// GET /api/branch/videos
async function listVideos(req, res, next) {
  try {
    const { feed, category, q, cursor, limit } = listQuery.parse(req.query);

    const filter = {};

    if (feed === "following") {
      if (!req.user) return res.json({ ok: true, items: [], nextCursor: null });
      const follows = await Follow.find({ follower: req.user._id }).select("following").lean();
      const authorIds = follows.map((f) => f.following);
      if (!authorIds.length) return res.json({ ok: true, items: [], nextCursor: null });
      filter.author = { $in: authorIds };
    }

    if (category && category !== "全部" && category.toLowerCase() !== "all") {
      filter.category = category;
    }

    if (q) {
      const re = new RegExp(escapeRegExp(q), "i");
      filter.$or = [{ title: re }, { description: re }];
    }

    // ★ 可见性条件用 $and 拼，不能往 filter 上直接挂 $or ——
    //   搜索（q）已经占用了顶层 $or，两个 $or 合并会互相覆盖，
    //   结果是「搜索时 private 泄漏」或「不搜索时什么都查不到」，取决于谁后写。
    const range = cursorFilter(cursor);
    const parts = [filter, visibilityFilter(req.user)];
    if (range) parts.push(range);
    const query = { $and: parts };

    const docs = await BranchVideo.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1) // 多取一条判断是否还有下一页
      .populate("author", AUTHOR_FIELDS)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const likedSet = await loadLikedSet(req.user, page);

    res.json({
      ok: true,
      items: page.map((doc) =>
        toVideoPayload(doc, {
          liked: likedSet.has(String(doc._id)),
          isOwner: ownedBy(doc, req.user),
        })
      ),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/branch/videos
async function createVideo(req, res, next) {
  try {
    const draft = req.body;
    if (!Array.isArray(draft.segments) || draft.segments.length === 0) {
      badRequest("segments is required");
    }

    // 幂等：转存几段方舟视频要几十秒，客户端很容易先超时再重发，而第一次其实已经落库了。
    // 先按 {author, clientId} 查一次，命中就直接把首次那条还回去（连转存都不用重做）。
    const clientId = typeof draft.clientId === "string" ? draft.clientId.trim() : "";
    if (clientId) {
      const dup = await BranchVideo.findOne({ author: req.user._id, clientId })
        .populate("author", AUTHOR_FIELDS)
        .lean();
      if (dup) {
        return res.status(200).json({
          ok: true,
          video: toVideoPayload(dup, { liked: false, isOwner: true, comments: [] }),
        });
      }
    }

    // 关键步骤：dataURL / 方舟 TOS 链接转存为 Cloudinary 永久地址
    const { cover, segments, branchTree, deck } = await transferDraftAssets(draft, String(req.user._id));

    let doc;
    try {
      doc = await BranchVideo.create({
        title: draft.title,
        category: draft.category || "",
        description: draft.description || "",
        cover: cover || segments[0]?.firstFrame || "",
        segments,
        ...(branchTree ? { branchTree } : {}),
        ...(deck && deck.cards.length ? { deck } : {}),
        ...(draft.pricing && draft.pricing.mode === "paid" ? { pricing: draft.pricing } : {}),
        visibility: draft.visibility === "private" ? "private" : "public",
        author: req.user._id,
        ...(clientId ? { clientId } : {}),
        plays: 0,
        likes: 0,
        commentCount: 0,
      });
    } catch (err) {
      // 两次重发几乎同时到达：上面的查重都扑空，唯一索引在这里兜底
      if (err && err.code === 11000 && clientId) {
        const dup = await BranchVideo.findOne({ author: req.user._id, clientId })
          .populate("author", AUTHOR_FIELDS)
          .lean();
        if (dup) {
          return res.status(200).json({
            ok: true,
            video: toVideoPayload(dup, { liked: false, isOwner: true, comments: [] }),
          });
        }
      }
      throw err;
    }

    const populated = await BranchVideo.findById(doc._id).populate("author", AUTHOR_FIELDS).lean();
    res.status(201).json({
      ok: true,
      video: toVideoPayload(populated, { liked: false, isOwner: true, comments: [] }),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/branch/videos/:id
async function getVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const doc = await BranchVideo.findById(id).populate("author", AUTHOR_FIELDS).lean();
    if (!doc) notFound("Video not found");
    // 仅自己可见的作品对别人一律 404 而不是 403：403 等于确认「这个 id 上有东西」，
    // 拿着链接的人照样能数出作者发了多少条私密作品。
    if (!visibleTo(doc, req.user)) notFound("Video not found");

    const [comments, liked] = await Promise.all([
      BranchComment.find({ video: id })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate("author", AUTHOR_FIELDS)
        .lean(),
      req.user ? BranchLike.exists({ user: req.user._id, video: id }) : Promise.resolve(null),
    ]);

    res.json({
      ok: true,
      video: toVideoPayload(doc, {
        liked: !!liked,
        isOwner: ownedBy(doc, req.user),
        comments: comments.map(toCommentPayload),
      }),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/branch/videos/:id —— 作品编辑（仅作者）。
 *
 * ★ 只改**元信息**：标题 / 简介 / 分区 / 可见性。
 *   片段、分支树、卡组一概不收 —— 那些是「发布那一刻的样子」，改了就意味着
 *   已经看过、已经收藏过这条作品的人看到的东西会变。要换内容请重新发一条。
 *   （产品上也已经定了：作品一经发布不能回炉。）
 */
async function updateVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const doc = await BranchVideo.findById(id).select("_id author").lean();
    if (!doc) notFound("Video not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    // validate 已经把未声明字段 strip 掉了，这里的 body 只可能是那五个键。
    // ★ cover 的 schema 已经把它限成 http(s) URL（不收 dataURL，见 schemas 里的说明），
    //   所以这里不需要再走 transferImage —— 客户端传上来的就已经是永久地址了。
    const patch = req.body;
    const updated = await BranchVideo.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" })
      .populate("author", AUTHOR_FIELDS)
      .lean();

    res.json({
      ok: true,
      video: toVideoPayload(updated, { isOwner: true }),
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/branch/videos/:id
async function removeVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const doc = await BranchVideo.findById(id).select("_id author").lean();
    if (!doc) notFound("Video not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      BranchVideo.deleteOne({ _id: id }),
      BranchLike.deleteMany({ video: id }),
      BranchComment.deleteMany({ video: id }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/branch/videos/:id/play
async function addPlay(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    // 可见性条件写进**更新的查询条件**里，而不是先查再改：
    // 拆成两步就多一个竞态窗口，而且白白多一次往返。
    const updated = await BranchVideo.findOneAndUpdate(
      { $and: [{ _id: id }, visibilityFilter(req.user)] },
      { $inc: { plays: 1 } },
      { returnDocument: "after", select: "plays" }
    ).lean();
    if (!updated) notFound("Video not found");

    res.json({ ok: true, plays: Number(updated.plays || 0) });
  } catch (err) {
    next(err);
  }
}

/** 用 BranchLike 重算并回写 likes，返回最新计数 */
async function syncLikes(videoId) {
  const likes = await BranchLike.countDocuments({ video: videoId });
  await BranchVideo.updateOne({ _id: videoId }, { $set: { likes } });
  return likes;
}

// POST /api/branch/videos/:id/like
async function likeVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    await assertVisible(id, req.user);

    // 唯一索引 + upsert：重复点赞幂等，不会把计数刷高
    await BranchLike.updateOne(
      { user: req.user._id, video: id },
      { $setOnInsert: { user: req.user._id, video: id } },
      { upsert: true }
    );

    res.json({ ok: true, likes: await syncLikes(id), liked: true });
  } catch (err) {
    // 并发下 upsert 可能撞唯一索引，视作已点赞
    if (err && err.code === 11000) {
      try {
        return res.json({ ok: true, likes: await syncLikes(req.params.id), liked: true });
      } catch (inner) {
        return next(inner);
      }
    }
    next(err);
  }
}

// DELETE /api/branch/videos/:id/like
async function unlikeVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    await assertVisible(id, req.user);

    await BranchLike.deleteOne({ user: req.user._id, video: id });

    res.json({ ok: true, likes: await syncLikes(id), liked: false });
  } catch (err) {
    next(err);
  }
}

// GET /api/branch/videos/:id/comments
async function listComments(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const { cursor, limit } = commentListQuery.parse(req.query);

    await assertVisible(id, req.user);

    const range = cursorFilter(cursor);
    const query = range ? { $and: [{ video: id }, range] } : { video: id };

    const docs = await BranchComment.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate("author", AUTHOR_FIELDS)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    res.json({
      ok: true,
      items: page.map(toCommentPayload),
      nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/branch/videos/:id/comments
async function addComment(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    await assertVisible(id, req.user);

    const doc = await BranchComment.create({
      video: id,
      author: req.user._id,
      text: req.body.text,
    });

    const commentCount = await BranchComment.countDocuments({ video: id });
    await BranchVideo.updateOne({ _id: id }, { $set: { commentCount } });

    const populated = await BranchComment.findById(doc._id).populate("author", AUTHOR_FIELDS).lean();
    res.status(201).json({ ok: true, comment: toCommentPayload(populated), commentCount });
  } catch (err) {
    next(err);
  }
}

/**
 * 看不见的作品在子端点上也必须是「不存在」。
 * 否则点赞/评论/弹幕这几条就成了探测私密作品是否存在的旁路（403 与 404 是两种信息）。
 * ★ 原来这段在三个函数里各写了一遍，加弹幕就是第四遍 —— 收成一处（铁律六）。
 */
async function assertVisible(id, user) {
  const exists = await BranchVideo.exists({ $and: [{ _id: id }, visibilityFilter(user)] });
  if (!exists) notFound("Video not found");
}

/**
 * 弹幕**不透出作者**，只告诉你"这条是不是你自己发的"。
 *
 * ★ 这是刻意的，不是偷懒：弹幕在 B 站那套心智里是匿名的，把 username 挂上去，
 *   一条作品的弹幕墙就成了"谁在什么时间看了这个视频"的公开记录。
 *   客户端需要作者信息的唯一用途是给自己发的那条描个边，`mine` 一个布尔够了。
 */
function toDanmakuPayload(doc, user) {
  return {
    _id: doc._id,
    at: doc.at,
    text: doc.text || "",
    color: doc.color || "",
    mine: !!user && String(doc.author) === String(user._id),
    createdAt: doc.createdAt,
  };
}

// GET /api/branch/videos/:id/danmaku
async function listDanmaku(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    const { limit } = danmakuListQuery.parse(req.query);
    await assertVisible(id, req.user);

    // ★ 采样口径：**先按发布时间取最新的 limit 条，再按时间轴排序返回**。
    //   不是"按 at 取前 N 条" —— 那样一条爆火作品的前 10 秒会被塞满，
    //   后面永远是空的，新弹幕发出去也看不见。
    //   客户端拿到的必须是 at 升序：播放端是按游标扫时间轴的，乱序会漏放。
    const docs = await BranchDanmaku.find({ video: id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .select("at text color author createdAt")
      .lean();

    const items = docs.map((d) => toDanmakuPayload(d, req.user)).sort((a, b) => a.at - b.at);
    // truncated：明确告诉客户端"这不是全部"。不给这个标记的话，
    // 客户端没法区分"这条作品就这么多弹幕"和"被我们截断了"
    res.json({ ok: true, items, truncated: docs.length >= limit });
  } catch (err) {
    next(err);
  }
}

// POST /api/branch/videos/:id/danmaku
async function addDanmaku(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    await assertVisible(id, req.user);

    const doc = await BranchDanmaku.create({
      video: id,
      author: req.user._id,
      at: req.body.at,
      text: req.body.text,
      color: req.body.color || "",
    });
    res.status(201).json({ ok: true, danmaku: toDanmakuPayload(doc, req.user) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listVideos,
  createVideo,
  getVideo,
  updateVideo,
  removeVideo,
  addPlay,
  likeVideo,
  unlikeVideo,
  listComments,
  addComment,
  listDanmaku,
  addDanmaku,
  // 导出给测试/其它模块复用
  transferDraftAssets,
  isArkVideoUrl,
};
