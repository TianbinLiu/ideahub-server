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
const BranchCommentLike = require("../models/BranchCommentLike");
const BranchDanmaku = require("../models/BranchDanmaku");
const Notification = require("../models/Notification"); // 只用于通知去重的 exists() 查询，写入一律走 service
const Follow = require("../models/Follow");
const { uploadToCloudinary } = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const { listQuery, commentListQuery, danmakuListQuery } = require("../schemas/branchVideo.schemas");
const { createNotification } = require("../services/notification.service");
// @提及解析全仓只有这一份（ideas 那两个 controller 也调它），别在这里另写一个正则
const { parseMentions } = require("../utils/mentionParser");
// 拉黑关系的权威判据。★ 全仓统一走它：messages.controller 用它拒私信、
// users.controller 用它把拉黑对象从搜索结果里滤掉，通知这条路也必须认同一份判断。
const { hasAnyBlockBetween } = require("../utils/blocking");

const AUTHOR_FIELDS = "_id username displayName avatarUrl";
// 评论里 @ 到的人。★ 与 AUTHOR_FIELDS 同一组字段：提及在客户端也是渲染成
// 「头像 + 名字」的小挂件，缺 avatarUrl 就只能画字母底。
const MENTION_USER_FIELDS = AUTHOR_FIELDS;

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

/**
 * 一条评论里**解析成功**的 @提及，供客户端把 text 里那几段变成可点的链接。
 *
 * ★ 只回解析成功的。`@nobody` 不在这个列表里，客户端就让它保持纯文本 ——
 *   用户由此**看得见**自己那个 @ 到底有没有生效（反正静默加个点不开的链接更糟）。
 * ★ 存量评论没有 mentions 字段，读出来是 undefined。这里 `Array.isArray(x) ? x : []`
 *   把它归一成空数组：对老评论而言"没有提及"就是事实本身，不是把未知当成了否定
 *   ——所以这一处**可以**用肯定式判断（与 visibility 那种"后加字段必须判否定"不同：
 *   那边 undefined 的真实含义是 public，这边 undefined 的真实含义就是"没有"）。
 * ★ 名字取的是 populate 出来的**当下**的值，不是写入时的快照：displayName 可变，
 *   存快照就会在对方改名后对不上（app 仓 renameMyVideos 那个坑）。
 */
function toMentionsPayload(doc) {
  const rows = Array.isArray(doc?.mentions) ? doc.mentions : [];
  const out = [];
  for (const m of rows) {
    const u = m && m.user;
    // 没 populate（裸 ObjectId）或用户已被删 → 丢掉这一条，客户端当纯文本渲染。
    // 不能退化成"只给 userId"：客户端拿不到名字只会画出一串十六进制，比不加链接更糟。
    if (!u || typeof u !== "object" || !u._id) continue;
    out.push({
      token: m.token || `@${u.username || ""}`,
      userId: u._id,
      username: u.username || "",
      displayName: u.displayName || "",
    });
  }
  return out;
}

/**
 * 一条评论。
 * ★ `parentId` 判的是**有无**（`doc.parent ? ... : null`），不是等值：字段后加，
 *   存量评论这一项是 undefined，等值判会把老评论整批当成回复（见模型里的说明）。
 * @param ctx.likedIds 当前用户点过赞的评论 id 集合（未登录时是空集）
 */
function toCommentPayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: toAuthorPayload(doc.author),
    text: doc.text || "",
    parentId: doc.parent ? String(doc.parent) : null,
    likes: Number(doc.likes || 0),
    liked: !!(ctx.likedIds && ctx.likedIds.has(String(doc._id))),
    // 老客户端不认这个键，多给不影响；新客户端拿不到（对着老服务端）时要按 [] 兜底
    mentions: toMentionsPayload(doc),
    createdAt: doc.createdAt,
  };
}

/** 当前用户在这批评论里点过赞的集合（与 loadLikedSet 同构） */
async function loadCommentLikedSet(user, docs) {
  if (!user || !docs.length) return new Set();
  const likes = await BranchCommentLike.find({
    user: user._id,
    comment: { $in: docs.map((d) => d._id) },
  })
    .select("comment")
    .lean();
  return new Set(likes.map((x) => String(x.comment)));
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

// ── 通知 ─────────────────────────────────────────────────────────

/** 通知正文里带的评论预览截多长。列表一行放得下就行，太长会把 payload 撑成半篇评论 */
const NOTIF_TEXT_MAX = 60;

function preview(text) {
  const s = String(text || "").trim();
  return s.length > NOTIF_TEXT_MAX ? `${s.slice(0, NOTIF_TEXT_MAX)}…` : s;
}

/**
 * 通知去重窗口。24 小时：够长，能挡住"取消再点、取消再点"刷一整天通知；
 * 又够短，隔天再来一次的真实互动仍然提醒得到。
 */
const NOTIF_DEDUP_WINDOW_MS = Number(process.env.BRANCH_NOTIF_DEDUP_MS || 24 * 60 * 60 * 1000);

/**
 * ★★ 哪些通知要去重、按什么维度去重 —— **全仓只有这一张表**。
 *
 *   分成两类，判据是"这件事重复发生时，接收者想不想再被提醒一次"：
 *   · 可撤销的状态（赞）→ **要去重**。点赞端点本身是幂等的（BranchLike 唯一索引），
 *     但取消点赞会把那一行**删掉**，于是下一次点赞的 upsertedCount 又是 1、又发一条。
 *     "取消 → 再点"是一次鼠标双击的成本，不去重的话它就是一台对着别人收件箱的打桩机。
 *     值列出的是**除 {userId, actorId, type, videoId} 之外**还要一起比的 payload 字段：
 *     赞评论要带上 commentId，否则赞了同一条作品下的两条不同评论只会提醒一次。
 *   · 新内容（评论、回复）→ **不去重**。每一条都是一段新的话，漏提醒就是真丢消息。
 *     它们也不需要去重：发一条评论的成本远高于点两下赞，且已经有 branch:comment 限流。
 *
 *   ⚠ 加新的 BRANCH_* 类型时先回答"重复做同一件事会怎样"，再决定要不要进这张表。
 *
 *   · BRANCH_MENTION → **不去重**，与评论/回复同一类。理由：一次提及必然搭在一条**新评论**
 *     上，去重键 {userId, actorId, type, videoId} 会把"同一个人在同一条作品下再 @ 我一次"
 *     整整压 24 小时 —— 也就是一场正常的多轮对话里，从第二句起我就再也收不到提醒了。
 *     那不是防刷，那是丢消息。
 *     "机器人反复 @" 这条已经被三道门夹住了：branch:comment 限流 20/分钟、
 *     每条评论最多 10 个提及（mentionParser 的 MAX_RESOLVED_MENTIONS）、以及下面
 *     addComment 里"同一条评论对同一个人只发一条"的优先级去重。
 *     而且它没有点赞那种"删一行再插一行"的廉价复位手法（发评论要真发一条评论）。
 */
const NOTIF_DEDUP_KEYS = {
  BRANCH_LIKE: [],
  BRANCH_COMMENT_LIKE: ["commentId"],
};

/** 这条通知是不是「窗口内已经发过的同一件事」 */
async function alreadyNotified({ userId, actorId, videoId, type, payload = {} }) {
  const extraKeys = NOTIF_DEDUP_KEYS[type];
  if (!extraKeys || !userId || !actorId) return false;
  const query = {
    userId,
    actorId,
    type,
    videoId,
    createdAt: { $gte: new Date(Date.now() - NOTIF_DEDUP_WINDOW_MS) },
  };
  for (const key of extraKeys) query[`payload.${key}`] = payload[key];
  return !!(await Notification.exists(query));
}

/**
 * 发一条分支视频相关的通知。五个 BRANCH_* 发送点全部走这里，去重与拉黑闸门也就只有这一处。
 *
 * ★★ **必须** try/catch：createNotification 出错是 rethrow 的（见 service），
 *   不接住的话「点赞成功但通知没写进去」会变成一个 500 —— 用户看到的是点赞失败，
 *   而实际上赞已经记上了。通知是附加物，不能反过来把主操作拖垮。
 *   但也不能空 catch（铁律八）：console.error 留下痕迹，排查时看得见。
 * ★ videoId 走**顶层参数**（createNotification 的签名里就有）：payload 是 Mixed，
 *   塞在那里只能靠约定；顶层那列是 ref:"BranchVideo"，列表端点直接 populate 出标题与封面，
 *   去重查询也能吃上索引。payload 里那份**同名值留着不删**：老版本 app 读的是它，
 *   删掉等于让已经装在用户手机上的那些包点不开通知（而它们不会自动更新）。
 *
 * ★★ 拉黑闸门放在**这里**，不放在各个发送点上（铁律六）。
 *   B 拉黑 A 之后，A 已经私不了信（messages.controller 的 hasAnyBlockBetween）、
 *   也不会再出现在 B 的搜索结果里（users.controller 的 listBlockedUserIds）——
 *   唯独通知这条路原来一个字都没判：A 在任意一条公开作品下打一句 `@B` 就能
 *   把消息塞进 B 的收件箱，按评论限流的频率可以一直发。
 *   而拉黑对 B 的承诺就是"这个人到不了我这儿"，漏一条路径这个承诺就是假的。
 *   BRANCH_LIKE / BRANCH_COMMENT / BRANCH_COMMENT_REPLY / BRANCH_COMMENT_LIKE
 *   原来是同一个洞（赞一下也是一条通知），收在这一处就四条一起堵上了；
 *   以后加新的 BRANCH_* 类型也自动带上，不用记得再抄一遍。
 * ★ 双向判（hasAnyBlockBetween 而不是"只看接收者拉没拉发送者"）：
 *   我拉黑了某人，就不想再看见与他有关的任何动静 —— 收到"他赞了你"同样是被打扰。
 * ★ 只挡**通知**，不挡评论本身：评论能不能发是作品可见性决定的，
 *   在这里连带把评论也拒了会变成"拉黑 = 封别人的嘴"，那是另一件事，也会泄漏拉黑关系
 *   （对方能从 403 推断出自己被谁拉黑了）。
 */
async function notifyBranch(scope, args) {
  try {
    if (await hasAnyBlockBetween(args.actorId, args.userId)) return;
    if (await alreadyNotified(args)) return;
    await createNotification(args);
  } catch (err) {
    console.error(`[branch] ${scope} 通知创建失败:`, err?.message || err);
  }
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
    const { feed, category, q, cursor, limit, author } = listQuery.parse(req.query);

    const filter = {};

    // 按作者筛：给"看别人的主页"用。
    // ★ 非法 id 一律 400，**不能**放任它进 Mongo —— CastError 会被兜成 500，
    //   而这是调用方拼错了参数，500 会让人去查服务器日志里根本不存在的故障。
    //   也不静默返回空列表：空列表的意思是"这个人没有作品"，与"你这个 id 是错的"
    //   在界面上必须分得开（铁律八）。
    let authorFilter = null;
    if (author) {
      if (!isValidId(author)) badRequest("Invalid author id");
      authorFilter = { author: new mongoose.Types.ObjectId(author) };
    }

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
    // ★ author 也走 $and 的一个独立分量，不是 `filter.author = ...`：
    //   feed=following 时 filter.author 已经是 `{$in:[...]}` 了，直接赋值会把它覆盖掉
    //   （表现是"关注页按作者筛"变成"全站按作者筛"，静默越权到未关注的人）。
    //   拆成两个分量则天然是交集：既在关注列表里、又是这个作者。
    // ★★ visibilityFilter 那一项**必须留在这里**：author 只是"筛谁的"，
    //   "能不能看"仍然由它决定。所以问别人要作品拿到的是对方的公开作品，
    //   问自己要才连私密的一起给 —— 少了它就是一行代码把所有人的私密作品全泄了。
    const range = cursorFilter(cursor);
    const parts = [filter, visibilityFilter(req.user)];
    if (authorFilter) parts.push(authorFilter);
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
      // ★★ 把**真正生效了的** author 回显出去。这是给客户端的能力探针：
      //   老服务端不认这个参数，zod 会把它 strip 掉然后**照常返回推荐流**
      //   （不是空表、也不是 400），客户端光看回包内容分不出
      //   「按作者筛过、这个人没作品」与「压根没筛、只是这一页恰好是空的」——
      //   于是别人的主页会斩钉截铁地写「TA 还没有发布作品」，而我们根本没问过他。
      //   回显一个键就把它变成**判形状**（这个键在不在），而不是猜内容；
      //   状态码在 Capacitor 那边永远是 200，判不出任何东西。
      ...(authorFilter ? { author } : {}),
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
        // 明天再读这条评论，@ 也得还能变成链接 —— 所以提及是**落库**的，
        // 这里 populate 出当下的名字（不用写库时的快照，对方改名后会对不上）
        .populate("mentions.user", MENTION_USER_FIELDS)
        .lean(),
      req.user ? BranchLike.exists({ user: req.user._id, video: id }) : Promise.resolve(null),
    ]);
    const commentLikedIds = await loadCommentLikedSet(req.user, comments);

    res.json({
      ok: true,
      video: toVideoPayload(doc, {
        liked: !!liked,
        isOwner: ownedBy(doc, req.user),
        comments: comments.map((c) => toCommentPayload(c, { likedIds: commentLikedIds })),
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

    // 评论点赞表挂在 comment 上而不是 video 上，所以要先把这条作品的评论 id 捞出来，
    // 否则删完作品那些 BranchCommentLike 会永远留在库里（谁也再查不到、也删不掉）。
    const commentIds = (await BranchComment.find({ video: id }).select("_id").lean()).map((c) => c._id);

    await Promise.all([
      BranchVideo.deleteOne({ _id: id }),
      BranchLike.deleteMany({ video: id }),
      BranchComment.deleteMany({ video: id }),
      commentIds.length ? BranchCommentLike.deleteMany({ comment: { $in: commentIds } }) : Promise.resolve(),
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

    const video = await assertVisible(id, req.user, "_id author title");

    // 唯一索引 + upsert：重复点赞幂等，不会把计数刷高
    const r = await BranchLike.updateOne(
      { user: req.user._id, video: id },
      { $setOnInsert: { user: req.user._id, video: id } },
      { upsert: true }
    );

    // ★ 只有**真的插进去了一行**才发通知（upsertedCount === 1）：点赞端点是幂等的，
    //   客户端重试、用户反复点、弱网重发都很常见，不判这一下的话每 POST 一次作者就多收一条。
    // ★★ 但这一条**挡不住"取消 → 再点"**：DELETE 把 BranchLike 那行删了，
    //   下一次 upsertedCount 又是 1。真正的门在 notifyBranch 的去重窗口里（见那里的说明），
    //   这里保留 upsertedCount 判断是因为它更早、更便宜（不用查收件箱）。
    if (r && r.upsertedCount === 1) {
      await notifyBranch("likeVideo", {
        userId: video.author,
        actorId: req.user._id,
        videoId: id,
        type: "BRANCH_LIKE",
        payload: { videoId: id, videoTitle: video.title || "" },
      });
    }

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
      .populate("mentions.user", MENTION_USER_FIELDS)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const likedIds = await loadCommentLikedSet(req.user, page);

    // 顶层评论与回复在同一个扁平列表里返回（每条带 parentId），由客户端按父子分组。
    // ★ 刻意不做「只回顶层、回复另开一个端点」：评论区一次要展示的就是整棵两层树，
    //   拆两个端点等于每条顶层评论一次请求，抽屉打开要打十几个。
    res.json({
      ok: true,
      items: page.map((d) => toCommentPayload(d, { likedIds })),
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

    // ★ 这里必须把 visibility 也 select 出来：下面 @提及的可见性闸门要拿它喂 visibleTo。
    //   漏掉的表现是 doc.visibility === undefined → `!== "private"` 恒真 → 私密作品里的
    //   @ 照样把通知发出去（闸门静默失效，且一个错都不报）。
    const video = await assertVisible(id, req.user, "_id author title visibility");

    const parentId = req.body.parentId;
    let parent = null;
    if (parentId) {
      if (!isValidId(parentId)) invalidId("Invalid parent comment id");
      // ★ 必须把 parent 自己的 parent 也 select 出来 —— 下面要靠它把「回复的回复」
      //   挂回顶层。漏了这一列的表现是第三层评论静默地自成一楼（读不到就是 undefined）。
      parent = await BranchComment.findById(parentId).select("_id video author parent").lean();
      if (!parent) notFound("Parent comment not found");
      // ★ 必须核对父评论确实属于这条作品。不核的话，拿一条**私密作品**里的评论 id
      //   往一条公开作品的评论端点上一挂，就能给那条私密评论生出一个可见的子节点
      //   —— 可见性判断被从旁边绕过去了（与 assertVisible 挡的是同一类旁路）。
      if (String(parent.video) !== String(id)) badRequest("parent comment belongs to another video");
    }

    // ★★ @提及由**服务端自己从正文解析**，客户端传上来的收件人名单一概不看
    //   （schema 里也没声明这个字段，z.object 会 strip 掉）。收客户端名单等于开一个
    //   "给任意用户发推送"的接口：正文里一个 @ 都没有，照样能点名一百个人。
    //   解析实现只有一份，在 utils/mentionParser（ideas 那两条评论路径共用同一份）。
    const { mentions } = await parseMentions(req.body.text);

    const doc = await BranchComment.create({
      video: id,
      author: req.user._id,
      text: req.body.text,
      // 两层封顶：回复一条回复时仍然挂到它的顶层父上（parent.parent 存在就用它）。
      // 不这么做的话评论区会无限缩进，而 UI 只画两层 —— 第三层往下会直接看不见。
      ...(parent ? { parent: parent.parent || parent._id } : {}),
      // 只存 {user, token}：名字在读的时候 populate（见模型里的说明）。
      // ★ 落库的是**全部解析成功**的提及，不是"被通知到的那些"。可见性闸门只管**通知**；
      //   渲染归渲染 —— 这条评论本身能被谁看见，早已由作品的可见性决定了。
      ...(mentions.length
        ? { mentions: mentions.map((m) => ({ user: m.userId, token: m.token })) }
        : {}),
    });

    const commentCount = await BranchComment.countDocuments({ video: id });
    await BranchVideo.updateOne({ _id: id }, { $set: { commentCount } });

    const populated = await BranchComment.findById(doc._id)
      .populate("author", AUTHOR_FIELDS)
      .populate("mentions.user", MENTION_USER_FIELDS)
      .lean();

    // ── 通知 ──────────────────────────────────────────────────────────
    // ★★ 「同一条评论对同一个人只发一条」的优先级**只有这一处实现**：notified 集合。
    //   顺序固定为「结构性通知 > 提及」：
    //     回复      → 被回复那条评论的作者收 BRANCH_COMMENT_REPLY
    //     顶层评论  → 作品作者收 BRANCH_COMMENT
    //     其余被 @ 到的人 → BRANCH_MENTION
    //   为什么让结构性通知赢：它带着同样的 deeplink、同样的正文预览，还**多**告诉你
    //   "这是回你的" / "这是你作品下的评论"。反过来（提及赢）会让作者收到一条
    //   "某某提到了你"，看不出这其实是他作品下的第一条评论。
    //   两条都发则是同一件事在收件箱里出现两次，点开去的还是同一个地方。
    const notified = new Set([String(req.user._id)]); // 自己 @ 自己不发（service 也会兜，这里更早更便宜）

    if (parent) {
      notified.add(String(parent.author));
      await notifyBranch("addReply", {
        userId: parent.author,
        actorId: req.user._id,
        videoId: id,
        type: "BRANCH_COMMENT_REPLY",
        payload: {
          videoId: id,
          commentId: doc._id,
          parentCommentId: parent._id,
          videoTitle: video.title || "",
          commentText: preview(doc.text),
        },
      });
    } else {
      notified.add(String(video.author));
      await notifyBranch("addComment", {
        userId: video.author,
        actorId: req.user._id,
        videoId: id,
        type: "BRANCH_COMMENT",
        payload: {
          videoId: id,
          commentId: doc._id,
          videoTitle: video.title || "",
          commentText: preview(doc.text),
        },
      });
    }

    for (const m of mentions) {
      const uid = String(m.userId);
      if (notified.has(uid)) continue;
      // ★★ 可见性闸门：只通知**真的看得见这条作品**的人。
      //   不判的话，在一条私密作品下 @ 某人 = 主动告诉他"这里有个你看不见的东西存在"，
      //   @ 就成了探测私密作品的探针（与 assertVisible / 核对 parent.video 挡的是同一类旁路）。
      //   复用 visibleTo 这**一处**判断（铁律六），绝不在这里另写一遍 visibility 的条件 ——
      //   另写一遍就意味着以后加"仅粉丝可见"时这里会被忘掉，而且忘了不报错。
      if (!visibleTo(video, { _id: m.userId })) continue;
      notified.add(uid);
      await notifyBranch("addMention", {
        userId: m.userId,
        actorId: req.user._id,
        videoId: id,
        type: "BRANCH_MENTION",
        payload: {
          videoId: id,
          commentId: doc._id,
          ...(parent ? { parentCommentId: parent._id } : {}),
          videoTitle: video.title || "",
          commentText: preview(doc.text),
        },
      });
    }

    res.status(201).json({ ok: true, comment: toCommentPayload(populated), commentCount });
  } catch (err) {
    next(err);
  }
}

/** 用 BranchCommentLike 重算并回写 BranchComment.likes（与 syncLikes 同构） */
async function syncCommentLikes(commentId) {
  const likes = await BranchCommentLike.countDocuments({ comment: commentId });
  await BranchComment.updateOne({ _id: commentId }, { $set: { likes } });
  return likes;
}

/**
 * 取出这条作品下的那条评论。
 * ★ 两件事一起判：作品可见 + 评论确实属于这条作品。评论 id 是全局唯一的，
 *   只按 commentId 查的话，把私密作品里的评论 id 挂到一条公开作品的路径下
 *   就能读写它 —— 与 addComment 里核对 parent.video 是同一条理由。
 */
async function loadVisibleComment(videoId, commentId, user) {
  if (!isValidId(videoId)) invalidId("Invalid video id");
  if (!isValidId(commentId)) invalidId("Invalid comment id");
  await assertVisible(videoId, user);
  const comment = await BranchComment.findById(commentId).select("_id video author text").lean();
  if (!comment || String(comment.video) !== String(videoId)) notFound("Comment not found");
  return comment;
}

// POST /api/branch/videos/:id/comments/:commentId/like
async function likeComment(req, res, next) {
  try {
    const { id, commentId } = req.params;
    const comment = await loadVisibleComment(id, commentId, req.user);

    const r = await BranchCommentLike.updateOne(
      { user: req.user._id, comment: commentId },
      { $setOnInsert: { user: req.user._id, comment: commentId } },
      { upsert: true }
    );

    // 同 likeVideo：只有真插进去那一次才发通知，否则重复 POST 就是一台发通知的机器。
    // "取消再赞"同样由 notifyBranch 的去重窗口挡住（按 commentId 分维度）。
    if (r && r.upsertedCount === 1) {
      await notifyBranch("likeComment", {
        userId: comment.author,
        actorId: req.user._id,
        videoId: id,
        type: "BRANCH_COMMENT_LIKE",
        payload: {
          videoId: id,
          commentId: comment._id,
          commentText: preview(comment.text),
        },
      });
    }

    res.json({ ok: true, likes: await syncCommentLikes(commentId), liked: true });
  } catch (err) {
    // 并发下 upsert 可能撞唯一索引，视作已点赞（与 likeVideo 一致）
    if (err && err.code === 11000) {
      try {
        return res.json({ ok: true, likes: await syncCommentLikes(req.params.commentId), liked: true });
      } catch (inner) {
        return next(inner);
      }
    }
    next(err);
  }
}

// DELETE /api/branch/videos/:id/comments/:commentId/like
async function unlikeComment(req, res, next) {
  try {
    const { id, commentId } = req.params;
    await loadVisibleComment(id, commentId, req.user);
    await BranchCommentLike.deleteOne({ user: req.user._id, comment: commentId });
    res.json({ ok: true, likes: await syncCommentLikes(commentId), liked: false });
  } catch (err) {
    next(err);
  }
}

/**
 * 看不见的作品在子端点上也必须是「不存在」。
 * 否则点赞/评论/弹幕这几条就成了探测私密作品是否存在的旁路（403 与 404 是两种信息）。
 * ★ 原来这段在三个函数里各写了一遍，加弹幕就是第四遍 —— 收成一处（铁律六）。
 * ★ 返回那条 doc（默认只取 _id）：点赞/评论要给**作者**发通知，就得知道作者是谁。
 *   为此再查一次 BranchVideo 等于把可见性判断的入口开成两个，早晚有一边忘了加条件。
 */
async function assertVisible(id, user, select = "_id") {
  const doc = await BranchVideo.findOne({ $and: [{ _id: id }, visibilityFilter(user)] })
    .select(select)
    .lean();
  if (!doc) notFound("Video not found");
  return doc;
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
  likeComment,
  unlikeComment,
  listDanmaku,
  addDanmaku,
  // 导出给测试/其它模块复用
  transferDraftAssets,
  isArkVideoUrl,
};
