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
// 只用于「读」与「清理」：去重的 exists() 查询，以及删评论时把指向它的通知一起删掉。
// **写入一律走 service**（createNotification），别在这里 create。
const Notification = require("../models/Notification");
const Follow = require("../models/Follow");
// 平台统计只用它数人头（countDocuments），不读任何字段
const User = require("../models/User");
const { uploadToCloudinary } = require("../middleware/upload");
const { cloudinary } = require("../config/cloudinary");
const PendingAssetPurge = require("../models/PendingAssetPurge");
// 「删一条作品要回收哪些云端资产」：地址枚举与归属判定各只有一处（见两个文件的 ★★）
const { assetUrlsOfVideo } = require("../utils/branchAssetRefs");
const { ownedRecyclableAsset, RECYCLABLE_FOLDERS } = require("../utils/templateVideoAsset");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const { listQuery, commentListQuery, danmakuListQuery } = require("../schemas/branchVideo.schemas");
// 卡片多图参考的"哪几张能存/能发出去"只有一处实现，卡片那条路与作品快照这条路共用
const { shareableViews } = require("./branchAsset.controller");
const { createNotification } = require("../services/notification.service");
// @提及解析全仓只有这一份（ideas 那两个 controller 走同一个模块的另一个入口），
// 别在这里另写一个正则、更别在这里另写一遍 span 的核对规则
const { parseMentionsWithSpans } = require("../utils/mentionParser");
// 拉黑关系的权威判据。★ 全仓统一走它：messages.controller 用它拒私信、
// users.controller 用它把拉黑对象从搜索结果里滤掉，通知这条路也必须认同一份判断。
const { hasAnyBlockBetween } = require("../utils/blocking");
// 「谁是管理员」全仓只有 utils/roles 一处判据（铁律六）。这里三个用途：
// 删除授权（assertCanDelete）、按 id 直取时越过可见性（assertVisible）、后台端点。
const { isAdmin } = require("../utils/roles");
// 封禁判据的查询侧写法（statsBanned 用）。文档侧判断在 middleware/auth，这里用不上
const { BANNED_FILTER } = require("../utils/banned");

const AUTHOR_FIELDS = "_id username displayName avatarUrl uid";
// 评论里 @ 到的人。★ 与 AUTHOR_FIELDS 同一组字段：提及在客户端也是渲染成
// 「头像 + 名字」的小挂件，缺 avatarUrl 就只能画字母底。
const MENTION_USER_FIELDS = AUTHOR_FIELDS;

// 转存失败时，超过该长度的 dataURL 不再内联落库（否则一条作品的 base64 会撑爆 16MB BSON 上限）
const MAX_INLINE_FALLBACK = Number(process.env.BRANCH_INLINE_FALLBACK_MAX || 512 * 1024);

// 方舟成片 → 永久地址的域名表 / 上限 / 拉取与上传，全仓只有 videoAsset.service 一份实现
// （出片后立即转存那条新路与这里共用，见 service 文件头的 ★）
const {
  isHttpUrl,
  isArkVideoUrl,
  uploadVideoBuffer,
  downloadToBuffer,
} = require("../services/videoAsset.service");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDataUrl(value) {
  return typeof value === "string" && /^data:[\w.+-]*\/?[\w.+-]*;base64,/i.test(value.trim());
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
        // 真人声明跟着快照走：观众「收入卡组」拿到的就是这份卡对象，掉了它，
        // 真人卡经作品这条路洗一遍就变回"非真人"，出片档位分流静默失效
        realPerson: c.realPerson === true,
        // 多图参考跟着快照走：少了它，观众装走这套卡组后炼出来的人物不是同一个人，
        // 而且一点错都不报。★ 这里**不需要**转存：views 只可能是永久 URL
        //   （客户端在加图那一刻就传过了），能不能带出去由 shareableViews 一处判（铁律六）
        views: shareableViews(c.views),
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
    // 老作品没有这个字段 → 空数组（读侧判否定，见 model 里那条 ★）
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    cover: doc.cover || "",
    segments: Array.isArray(doc.segments) ? doc.segments : [],
    author: toAuthorPayload(doc.author),
    plays: Number(doc.plays || 0),
    likes: Number(doc.likes || 0),
    commentCount: Number(doc.commentCount || 0),
    // 老数据没这个字段，对外一律归一成 "public"（客户端就不用再判 undefined）
    visibility: doc.visibility === "private" ? "private" : "public",
    // ★ 「凭链接可见」。只在为真时发这个键（老数据不发）—— 老客户端读不懂它，
    //   但它们看到的 visibility 是 "private"，那是**更严格**的一档，不会泄漏。
    ...(doc.linkOnly === true && doc.visibility === "private" ? { linkOnly: true } : {}),
    liked: !!ctx.liked,
    isOwner: !!ctx.isOwner,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  // 下架信息：**有这个键就是被下架了**，没有就是正常（与 pricing / deck 同一种给法）。
  // 能读到这条作品的只剩作者本人与管理员（readableBy），所以带上它是安全的，
  // 而且是必须的 —— 作者要看得见"为什么没了"。
  // ★ 刻意**不回 `by`**（除非是后台自己在看）：作者知道被下架了、为什么，就够了。
  //   把"具体是哪个管理员干的"透给用户，等于把审核员摆到被骚扰的位置上；
  //   库里存着，后台查得到，追责不受影响。
  if (isTakenDown(doc)) {
    payload.takedown = {
      at: doc.takedown.at,
      reason: doc.takedown.reason || "",
      ...(ctx.admin ? { by: doc.takedown.by } : {}),
    };
  }
  const tree = toBranchTreePayload(doc.branchTree);
  if (tree) payload.branchTree = tree;
  if (doc.deck && Array.isArray(doc.deck.cards) && doc.deck.cards.length) payload.deck = doc.deck;
  if (doc.pricing && doc.pricing.mode === "paid") payload.pricing = doc.pricing;
  if (ctx.comments) payload.comments = ctx.comments;
  return payload;
}

/**
 * 一条评论里**核对通过**的 @提及，供客户端把 text 里那几段替换成 `@` + 当前显示名。
 *
 * ★★ 这就是「改名之后，已经发出去的那些 @ 跟着显示新名字」的实现：
 *   落库的是 **userId + span**（`offset`/`length`），名字这里**现查**（populate 出来的
 *   当下的值）。渲染端把 `text` 的 [offset, offset+1+length) 换成 `@` + displayName。
 *   ⚠ 多个 span 要**从后往前**替换，否则前面那次替换会把后面的 offset 冲掉。
 *
 * ★ 只回核对通过的。`@nobody` 不在这个列表里，客户端就让它保持纯文本 ——
 *   用户由此**看得见**自己那个 @ 到底有没有生效（静默加个点不开的链接更糟）。
 * ★ 存量评论没有 mentions 字段，读出来是 undefined。这里 `Array.isArray(x) ? x : []`
 *   把它归一成空数组：对老评论而言"没有提及"就是事实本身，不是把未知当成了否定
 *   ——所以这一处**可以**用肯定式判断（与 visibility 那种"后加字段必须判否定"不同：
 *   那边 undefined 的真实含义是 public，这边 undefined 的真实含义就是"没有"）。
 * ★ `offset`/`length` 是**这一次新加**的字段，存量的提及行没有它们。同理是"全新字段"，
 *   缺失的含义就是"这行是老数据"，可以正向判断（`Number.isInteger`）。老行用 `token`
 *   在正文里反查一次把 span 补出来 —— 评论正文是**不可编辑**的，所以当年存进去的
 *   token 一定还原样躺在 text 里，反查是确定性的。补不出来（正文里找不到）就不给
 *   span，客户端退回按 token 做子串匹配（那正是老客户端一直在做的事）。
 */
function toMentionsPayload(doc) {
  const rows = Array.isArray(doc?.mentions) ? doc.mentions : [];
  const text = String(doc?.text || "");
  const out = [];
  for (const m of rows) {
    const u = m && m.user;
    // 没 populate（裸 ObjectId）或用户已被删 → 丢掉这一条，客户端当纯文本渲染。
    // 不能退化成"只给 userId"：客户端拿不到名字只会画出一串十六进制，比不加链接更糟。
    if (!u || typeof u !== "object" || !u._id) continue;
    const token = m.token || `@${u.username || ""}`;
    const span = resolveStoredSpan(text, m, token);
    out.push({
      token,
      userId: u._id,
      username: u.username || "",
      displayName: u.displayName || "",
      ...(span || {}),
    });
  }
  return out;
}

/**
 * token 反查时的前后边界，与 mentionParser 那条 `(?<![\w@])@([A-Za-z0-9_-]{1,32})`
 * **逐字对应**（也与 app 仓 utils/mention.ts 的两条常量对应）。
 *
 * ★★ 反查**必须**带上这两道，裸 `indexOf` 会指错地方，而且指错的后果比不给 span 更糟：
 *   存量评论「有事找我 bob@alice.com，顺便 @alice 看一下」里，当年解析成功的是**后面**
 *   那个 `@alice`（邮箱里那个被前置断言挡掉了，从来不算一次提及）。裸 indexOf 命中的
 *   却是**邮箱里**那一截 —— 客户端拿到这个 span 会把 [offset, offset+1+len) 换成
 *   `@` + 当前显示名，于是用户那条评论里的**邮箱地址被当面改写成了一个可点的链接**，
 *   而真正的那个 `@alice` 反倒不亮了（它已经带着 span，不会再走客户端的 token 兜底）。
 *   同型的还有 `@bobby ... @bob`：`@bob` 会命中 `@bobby` 的前半截。
 */
const TOKEN_PREV_BLOCK = /[A-Za-z0-9_@]/;
const TOKEN_NEXT_BLOCK = /[A-Za-z0-9_-]/;

/** 找 token 在正文里**边界成立**的第一处；找不到回 -1。 */
function findTokenAt(text, token) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return -1;
    const prev = at > 0 ? text[at - 1] : "";
    const next = text[at + token.length] || "";
    if ((!prev || !TOKEN_PREV_BLOCK.test(prev)) && (!next || !TOKEN_NEXT_BLOCK.test(next))) return at;
    from = at + 1;
  }
}

/**
 * 取这条提及在正文里的位置。存了就用存的（顺手核一次，正文与 token 必须对得上），
 * 没存（老数据）就用 token 反查一次。都不成立时返回 null —— 宁可不给 span，
 * 也不能给一个指错地方的 span：那会让客户端把正文里**别人的**名字换掉。
 * （不给 span 时客户端会退回按 token 做子串匹配，那条路自己带同样的边界判断。）
 */
function resolveStoredSpan(text, m, token) {
  if (Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length >= 1) {
    if (text.slice(m.offset, m.offset + token.length) === token) {
      return { offset: m.offset, length: m.length };
    }
  }
  const at = findTokenAt(text, token);
  if (at < 0) return null;
  return { offset: at, length: token.length - 1 };
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
 * 「这次删除放不放行」的**唯一**判据（铁律六）。三条删除端点共用：
 *   删作品   removeVideo   —— 主人只有作品作者
 *   删评论   removeComment —— 主人有两个：评论作者、作品作者
 *   删弹幕   removeDanmaku —— 同上：弹幕作者、作品作者
 *
 * ★ 为什么收成一个函数而不是在每处写 `if (isOwner || isAdmin) ... else forbidden`：
 *   那样"管理员算不算主人"这件事就有了三份实现。以后加第四条删除端点（比如删卡片）
 *   会**忘掉管理员**，而忘了不报错 —— 表现是"后台清不掉这一类内容"，
 *   要等到有人真的举报了才会发现。反方向更糟：某天把 isAdmin 写成 `role === "Admin"`
 *   之类，也只会在其中一处生效。
 *
 * ★ 返回**是谁批准的**而不是 true/false：调用方要靠它决定"要不要留一条管理员操作日志"。
 *   管理员删别人的东西是不可逆的越权操作，日志里必须留下痕迹（铁律八）。
 *
 * ★ 无权时抛 403 而不是 404：能走到这一步说明请求者本来就看得见这条内容
 *   （前面已经过了 assertVisible），403 一个字节的新信息都没多给。
 *   ⚠ 但**错误文案里不许带上主人是谁** —— 弹幕那条尤其致命，见 removeDanmaku。
 *
 * @param {{_id: any, role?: string}} user 当前用户
 * @param {...any} owners 这次删除涉及的全部"主人"（ObjectId / 已 populate 的对象 / undefined）
 * @returns {"owner"|"admin"} 授权来源
 */
function assertCanDelete(user, ...owners) {
  for (const owner of owners) {
    if (!owner) continue;
    if (String(owner._id || owner) === String(user._id)) return "owner";
  }
  // ★ 管理员判在最后：本人删自己的东西是常态，不该被记成一条管理员操作日志。
  if (isAdmin(user)) return "admin";
  return forbidden("Forbidden"); // forbidden 是 throw，这行只为让返回类型显式
}

/**
 * 「已下架」的**库内**判据。全仓只有这一对（铁律六）：列表过滤、后台列表、统计计数
 * 三处共用，模型里那条 partial 索引的条件也与 TAKEN_DOWN 逐字相同。
 *
 * ★ 判的是 **`takedown.at`** 而不是 `takedown` 本身。撤销下架走 `$unset`（整个子文档
 *   删掉），但万一哪天有人写成了 `takedown: null`，`{takedown:{$exists:true}}` 会判成
 *   "已下架" —— 那条作品就**永远**出不来了，而且一个错都不报。走 dot 路径的话
 *   null 的 `takedown.at` 判为"没下架"，坏数据的失败方向是"作品还在"，比"作品消失"轻得多。
 */
const TAKEN_DOWN = { "takedown.at": { $type: "date" } };
const NOT_TAKEN_DOWN = { "takedown.at": { $exists: false } };

/** 文档侧的同一条判据。⚠ 调用前确认 select 里带了 takedown，否则恒为 false（见 addComment） */
function isTakenDown(doc) {
  return !!(doc && doc.takedown && doc.takedown.at);
}

/**
 * 一条作品「谁读得到」的**唯一**判据，两条规则合在一起：
 *
 *   ① 可见性（作者自己的开关）：private 只有作者本人看得到。
 *      ★ 用 `!== "private"` 判而不是 `=== "public"`：字段是后加的，**存量作品这一项是
 *        undefined**，按等值判会把库里所有老作品判成不可见（表现是首页突然空了）。
 *   ② 下架（平台的开关）：被管理员下架的作品对所有人隐藏 —— **作者除外**。
 *      ★★ 作者必须看得见，而且看得见原因（toVideoPayload 会带上 takedown.reason）。
 *        直接从作者眼前抹掉比下架更糟：他只会以为系统吞了自己的作品，
 *        然后原样再发一遍，我们再下架一次，谁都不知道发生了什么。
 *
 * ★ 管理员在这里**能**越权 —— 但只在"按 id 直取"这条路上（getVideo / assertVisible）。
 *   列表那条路（readableFilter）**不给**：管理员刷首页、搜索时看到的应该和普通人一样，
 *   否则全站的私密作品会静静地躺在他的推荐流里。要审一条具体的作品就按 id 打开它。
 * ★ 传进来的 user 可能是"半个用户"（addComment 的提及闸门构造的是 `{_id: userId}`，
 *   没有 role）—— isAdmin 那时返回 false，方向是对的：拿不准就少给权限。
 */
function readableBy(doc, user) {
  if (ownedBy(doc, user) || isAdmin(user)) return true;
  if (isTakenDown(doc)) return false;
  // ★ 「凭链接可见」= 按 id 直取放行、列表里不出现。所以它只在**这一处**放行，
  //   readableFilter（列表那条）刻意不认它 —— 两处不一致是**有意的**，
  //   而这正是这个功能的定义。⚠ 改这两个函数时别"顺手统一"。
  if (doc?.visibility === "private" && doc?.linkOnly === true) return true;
  return doc?.visibility !== "private";
}

/**
 * 列表用的可读条件：公开且未下架的 + 自己的（未登录就只有前者）。
 * ★ 与 readableBy 是同一条规则的两种写法（一份给 Mongo，一份给已经取出来的文档），
 *   改一处必须改另一处。管理员在这里**不**越权，理由见 readableBy。
 */
function readableFilter(user) {
  const open = { visibility: { $ne: "private" }, ...NOT_TAKEN_DOWN };
  return user ? { $or: [open, { author: user._id }] } : open;
}

/**
 * **按 id 直取**用的可读条件 —— 与上面那条的差别只有一处：它认「凭链接可见」。
 *
 * ★★ 为什么必须单独有这一条（2026-08-30 发版前复核抓到，差点带着 bug 出包）：
 *   `assertVisible` 原来用的是 `readableFilter`（**列表**口径）。加了「凭链接可见」之后
 *   这两条口径**分家了** —— 于是拿到链接的人能打开作品（详情走 `readableBy`），
 *   但点赞 / 评论 / 发弹幕 / 播放计数全部 **404**，而且是静默的：
 *   界面上表现为"点了没反应"。功能看着上线了，实际只上线了一半。
 * ★ 这是 `readableBy` 的 Mongo 版：**同一条规则的两种写法，改一处必须改另一处**
 *   （与 readableFilter/readableBy 那对同样的约定）。
 * ★ 管理员在这里同样不越权，理由见 readableBy。
 */
function readableByIdFilter(user) {
  const open = {
    $or: [{ visibility: { $ne: "private" } }, { visibility: "private", linkOnly: true }],
    ...NOT_TAKEN_DOWN,
  };
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
      // ★ tags 也进搜索：作品详情页的标签芯片是**可点的**，点了就跳到这条搜索。
      //   不搜 tags 的话，用户点自己刚打的标签会得到"没有结果"——那比没有芯片更糟。
      //   （Mongo 对数组字段用正则 = 任一元素匹配即命中，不需要 $elemMatch）
      filter.$or = [{ title: re }, { description: re }, { tags: re }];
    }

    // ★ 可见性条件用 $and 拼，不能往 filter 上直接挂 $or ——
    //   搜索（q）已经占用了顶层 $or，两个 $or 合并会互相覆盖，
    //   结果是「搜索时 private 泄漏」或「不搜索时什么都查不到」，取决于谁后写。
    // ★ author 也走 $and 的一个独立分量，不是 `filter.author = ...`：
    //   feed=following 时 filter.author 已经是 `{$in:[...]}` 了，直接赋值会把它覆盖掉
    //   （表现是"关注页按作者筛"变成"全站按作者筛"，静默越权到未关注的人）。
    //   拆成两个分量则天然是交集：既在关注列表里、又是这个作者。
    // ★★ readableFilter 那一项**必须留在这里**：author 只是"筛谁的"，
    //   "能不能看"仍然由它决定。所以问别人要作品拿到的是对方的公开作品，
    //   问自己要才连私密的一起给 —— 少了它就是一行代码把所有人的私密作品全泄了。
    //   被下架的作品也走同一条（首页 / 分区 / 搜索 / 他人主页全部是这一个查询，
    //   所以"逐处过滤"实际上只有这一处 —— 别在别的地方另加一遍）。
    const range = cursorFilter(cursor);
    const parts = [filter, readableFilter(req.user)];
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
        tags: Array.isArray(draft.tags) ? draft.tags : [],
        cover: cover || segments[0]?.firstFrame || "",
        segments,
        ...(branchTree ? { branchTree } : {}),
        ...(deck && deck.cards.length ? { deck } : {}),
        ...(draft.pricing && draft.pricing.mode === "paid" ? { pricing: draft.pricing } : {}),
        visibility: draft.visibility === "private" ? "private" : "public",
        // 「凭链接可见」只在私密时有意义（见 model 的 ★）
        ...(draft.linkOnly === true && draft.visibility === "private" ? { linkOnly: true } : {}),
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
    // 拿着链接的人照样能数出作者发了多少条私密作品。被下架的作品同理
    // （作者与管理员除外，见 readableBy）。
    if (!readableBy(doc, req.user)) notFound("Video not found");

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
    // ★★ 作者**改不动 takedown**，这条现在是一道安全边界，不是顺手的性质：
    //   updateBody 里根本没有这个键，z.object 默认 strip，`$set: patch` 也就永远
    //   碰不到它。这是**核对过的**（读了 schemas/branchVideo.schemas.js 的 updateBody），
    //   不是假设；而且 tests/branchAdmin.spec.js 从外面钉了一条
    //   「作者 PATCH takedown 无效」的用例 —— 哪天有人给 updateBody 加个 .loose()
    //   或者把 takedown 声明进去，那条会红。
    //   ⚠ 这里**刻意不再写一遍 `delete patch.takedown`**：同一条规则写两处，
    //     以后只会有人改一处（铁律六）。真正的门在 schema 上。
    const patch = { ...req.body };
    // ★★ 「凭链接可见」只有在 private 下才成立。改回 public 时**必须把它清掉**，
    //   否则库里留下 `public + linkOnly:true` 这种自相矛盾的状态 —— 今天没人读它，
    //   但下一个人写判据时会撞上，而它不报错、只是行为诡异。
    //   ⚠ 用 $unset 而不是 `linkOnly: false`：这个字段判**有值**（default undefined），
    //     写个 false 进去等于给每条老作品凭空长出一个字段。
    const $unset = {};
    // ★★ 判据是「带了 visibility 却**没带** linkOnly」，不是「改成了 public」（2026-08-30 修正）。
    //   原来只在改回 public 时清 —— 于是老客户端（≤v2.36，它的 PATCH 白名单里根本没有
    //   linkOnly）无论怎么保存都碰不到那一位：它把这条作品显示成「仅自己可见」、
    //   提示语写着"别人拿到链接也打不开"，而链接照旧人人打得开。
    //   我在上一条 commit 里写"老客户端读到 private 更严格，失败方向从泄漏翻成过度保守"
    //   —— 那句话**只对显示成立、对效果不成立**：界面收紧了，实际没有。
    //   而这正是隐私功能最不该错的方向（本仓的规矩：往放心的方向说错比往吓人的方向说错更糟）。
    //   ⇒ 「带 visibility 不带 linkOnly」只可能来自老客户端，而它此刻表达的正是
    //     「仅自己可见」——按它说的办，往严的方向兜底。
    //   ★ 新客户端不受影响：`types.visibilityWire` 两个键一起发（private 显式发
    //     `linkOnly: false`），唯一不带的是 public，而那一档本来就该清掉这一位。
    if (patch.visibility !== undefined && patch.linkOnly === undefined) {
      $unset.linkOnly = "";
    }
    if (patch.visibility === "public") delete patch.linkOnly;
    const update = Object.keys($unset).length ? { $set: patch, $unset } : { $set: patch };
    const updated = await BranchVideo.findByIdAndUpdate(id, update, { returnDocument: "after" })
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

/**
 * DELETE /api/branch/videos/:id —— 硬删除，**不可逆**。
 *
 * ★ 两种人能删：作者本人、管理员（授权判据只有 assertCanDelete 一处）。
 *   这是管理员手里"不可逆"的那一档，可逆的那一档是下架（takedownVideo）——
 *   两档都要有：违规内容要能永久清掉，误判/申诉成立要能原样恢复。
 *   拿不准就先下架，删除没有后悔药（级联删掉的评论、弹幕、通知都回不来）。
 */
async function removeVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    // ★ 这里刻意**不过 assertVisible**：删自己的私密作品、管理员删一条已经下架的作品，
    //   都得走这条路。归属判断由 assertCanDelete 负责。
    const doc = await BranchVideo.findById(id).select("_id author title").lean();
    if (!doc) notFound("Video not found");
    const by = assertCanDelete(req.user, doc.author);
    if (by === "admin") {
      // 管理员删别人的作品是不可逆越权操作，必须留痕（铁律八）
      console.warn(
        `[branch] 管理员删除作品 video=${id} title=${String(doc.title || "").slice(0, 40)} ` +
          `author=${doc.author} admin=${req.user._id}`
      );
    }

    await purgeVideo(id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * 硬删一条作品要连带清掉的**五样东西**。少清一样都不报错，只是留下垃圾。
 *
 * ★ 提成函数是因为它现在有**两个**调用方：作者/管理员直接删（removeVideo），
 *   以及举报处理里的 action=delete（services/takedown.service）。
 *   在那边抄一份的结果一定是漏掉其中一两样，而漏了没有任何症状 ——
 *   库里只是多出一批谁也查不到、也再删不掉的行（铁律六）。
 */
async function purgeVideo(videoId) {
  // 评论点赞表挂在 comment 上而不是 video 上，所以要先把这条作品的评论 id 捞出来，
  // 否则删完作品那些 BranchCommentLike 会永远留在库里（谁也再查不到、也删不掉）。
  const commentIds = (await BranchComment.find({ video: videoId }).select("_id").lean()).map((c) => c._id);

  // ★★ 云端资产的**句柄先落库**（2026-08-30 补）。此前这个函数只清六张 Mongo 表，
  //   `uploader.destroy` 一次都没有 —— 用户删掉作品之后，成片与封面那几个 https 地址
  //   **仍然人人可访问**。删除是隐私诉求，这是它没被满足。
  //   顺序是这条改动的核心：① 读正文拿地址 → ② 句柄落 PendingAssetPurge →
  //   ③ 删六张表 → ④ 逐条 destroy，成功即删句柄行。任何一步失败，句柄都还在；
  //   而地址**只存在于那份正文里**，正文一删就再也找不回来（见 PendingAssetPurge 的 ★★）。
  const doc = await BranchVideo.findById(videoId).select("author cover segments branchTree").lean();
  const owner = doc && doc.author;
  const handles = [];
  if (doc && owner) {
    for (const url of assetUrlsOfVideo(doc)) {
      // 认不出的一律不动（外链、别人的资产、模板目录）—— 回收范围写宽一点，
      // 删一个号就会顺手 destroy 掉别人还在用的东西，且零报错
      const own = ownedRecyclableAsset(url, String(owner), RECYCLABLE_FOLDERS);
      if (own) handles.push({ ...own, owner, source: String(videoId) });
    }
  }
  if (handles.length) {
    try {
      // 同一个 publicId 只欠一次（并发删同一条、重试都靠 publicId 唯一索引幂等）
      await PendingAssetPurge.bulkWrite(
        handles.map((h) => ({
          updateOne: { filter: { publicId: h.publicId }, update: { $setOnInsert: h }, upsert: true },
        })),
        { ordered: false }
      );
    } catch (err) {
      // 唯一索引撞车 = 已经欠着了，不算失败；其它错误也只记日志：
      // ★ 不许因为"句柄没落住"就拒绝删除 —— 那会把用户的隐私诉求挡在我们的实现细节后面。
      if (!err || err.code !== 11000) console.warn("[branch] 资产句柄落库失败:", err?.message || err);
    }
  }

  await Promise.all([
    BranchVideo.deleteOne({ _id: videoId }),
    BranchLike.deleteMany({ video: videoId }),
    BranchComment.deleteMany({ video: videoId }),
    commentIds.length ? BranchCommentLike.deleteMany({ comment: { $in: commentIds } }) : Promise.resolve(),
    // ★ 弹幕也要一起删。漏掉它和上面那条 BranchCommentLike 是**同一个形状**的坑：
    //   作品没了之后，这些行谁也查不到（列表接口先 assertVisible，作品不存在直接 404）、
    //   也再删不掉（删弹幕的端点同样要先过作品这一关），就永远躺在库里。
    BranchDanmaku.deleteMany({ video: videoId }),
    // 指向这条作品的通知也一并清掉：点进去只会得到一条"作品不存在"，
    // 而红点却实实在在地亮着 —— 用户没有任何办法让它消下去。
    Notification.deleteMany({ videoId }),
  ]);

  // ④ 库删干净了才去动云端。失败**不抛**：作品已经没了，这时候报错只会让调用方
  //    以为"没删成"而重试一遍（那一遍会删掉别的东西）。欠着的那几行留给清扫器。
  await Promise.all(
    handles.map(async (h) => {
      try {
        await cloudinary.uploader.destroy(h.publicId, { resource_type: h.resourceType, invalidate: true });
        await PendingAssetPurge.deleteOne({ publicId: h.publicId });
      } catch (err) {
        await PendingAssetPurge.updateOne(
          { publicId: h.publicId },
          { $inc: { attempts: 1 }, $set: { lastError: String(err?.message || err).slice(0, 500) } }
        ).catch(() => {});
      }
    })
  );

  return { removed: 1 + commentIds.length, assets: handles.length };
}

// POST /api/branch/videos/:id/play
async function addPlay(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    // 可见性条件写进**更新的查询条件**里，而不是先查再改：
    // 拆成两步就多一个竞态窗口，而且白白多一次往返。
    // ★ 这里是**按 id** 的路（不是列表），所以用 readableByIdFilter —— 用列表口径的话，
    //   「凭链接可见」的作品播放量永远是 0，而作者会拿它判断作品受不受欢迎。
    //   ⚠ 这一处是 readableFilter 的第 2 个调用点，容易在改口径时被漏掉
    //   （它内联在 findOneAndUpdate 里，不经过 assertVisible）。
    const updated = await BranchVideo.findOneAndUpdate(
      { $and: [{ _id: id }, readableByIdFilter(req.user)] },
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

    // ★ 这里必须把 visibility **和 takedown** 也 select 出来：下面 @提及的可见性闸门
    //   要拿它们喂 readableBy。漏掉的表现是 doc.visibility === undefined →
    //   `!== "private"` 恒真 → 私密作品里的 @ 照样把通知发出去（闸门静默失效，
    //   且一个错都不报）。takedown 漏了是同一个形状：被下架的作品里 @ 一个人，
    //   等于告诉他"这里有个你看不见的东西"。
    const video = await assertVisible(id, req.user, "_id author title visibility takedown");

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

    // ★★ @提及走两条路合并，实现只有一份（utils/mentionParser，铁律六）：
    //   ① 客户端补全面板报上来的 `{userId, offset, length}` —— 服务端**逐条核对**
    //      「正文那一段确实写着这个人当下的名字」才收，核不过就丢掉这一条
    //      （不是整条评论 400：一个 @ 没生效不该把用户写好的一段话打回去）。
    //      中文昵称走这条 —— CJK 没有词边界，服务端自己是切不出「我是王桑」的。
    //   ② 服务端自己扫出来的 ASCII `@username` —— 手打的、以及**老版本 App**
    //      （它压根不发 spans）发上来的评论走这条。
    //   ⚠ 核对是这个字段的**全部**安全性：不核对就等于开一个"给任意用户发推送"的
    //     接口（正文里一个 @ 都没有，照样能点名一百个人）。
    const { mentions } = await parseMentionsWithSpans(req.body.text, req.body.mentions);

    const doc = await BranchComment.create({
      video: id,
      author: req.user._id,
      text: req.body.text,
      // 两层封顶：回复一条回复时仍然挂到它的顶层父上（parent.parent 存在就用它）。
      // 不这么做的话评论区会无限缩进，而 UI 只画两层 —— 第三层往下会直接看不见。
      ...(parent ? { parent: parent.parent || parent._id } : {}),
      // 只存 {user, token, offset, length}：**名字一个字都不存**，读的时候 populate
      // 出当下的值（见模型里的说明）—— 这就是"对方改名后，这条 @ 跟着显示新名字"。
      // ★ 落库的是**全部核对通过**的提及，不是"被通知到的那些"。可见性闸门只管**通知**；
      //   渲染归渲染 —— 这条评论本身能被谁看见，早已由作品的可见性决定了。
      ...(mentions.length
        ? {
            mentions: mentions.map((m) => ({
              user: m.userId,
              token: m.token,
              offset: m.offset,
              length: m.length,
            })),
          }
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
      //   复用 readableBy 这**一处**判断（铁律六），绝不在这里另写一遍 visibility 的条件 ——
      //   另写一遍就意味着以后加"仅粉丝可见"时这里会被忘掉，而且忘了不报错。
      //   （下架那条规则就是这么白捡的：加进 readableBy 之后这里自动跟上。）
      if (!readableBy(video, { _id: m.userId })) continue;
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
 * 删掉一批评论时要连带清理的**四样东西**。少清一样都不报错，只是留下垃圾：
 *   ① 这些评论的**回复** —— 留着就是一堆没有上文的孤儿（UI 只画两层，父没了就没处挂）；
 *   ② 它们的 BranchCommentLike 行 —— 挂在 comment 上，评论没了谁也再查不到、也删不掉
 *      （removeVideo 里踩过同一条，那里也是先把 commentIds 捞出来再删）；
 *   ③ 指向这些 commentId 的 Notification —— 不删的话点进去只会跳到一条已经不存在的
 *      评论，用户看到的是"通知点了没反应"，而且一个错都不报；
 *   ④ BranchVideo.commentCount —— 与 addComment 同一个口径：countDocuments 重算后
 *      整体 $set，不做裸 $inc（并发下会漂移）。
 *
 * ★ 回复只用查一层：addComment 会把「回复的回复」挂回顶层父（`parent.parent || parent._id`），
 *   所以评论树最多两层，`{parent: 顶层id}` 就是全部后代。删的是一条回复时它本身没有子节点。
 *
 * @returns {Promise<{removed: number, commentCount: number}>}
 */
async function purgeComments(videoId, rootCommentId) {
  const replyIds = (await BranchComment.find({ parent: rootCommentId }).select("_id").lean()).map(
    (c) => c._id
  );
  const ids = [rootCommentId, ...replyIds];
  // payload 是 Mixed：现有写入点传的都是 ObjectId，但 Mixed 存什么就是什么，
  // 两种形态一起匹配，免得以后有人传了字符串就留下一批指向空评论的通知。
  const idKeys = [...ids, ...ids.map(String)];

  const [removed] = await Promise.all([
    BranchComment.deleteMany({ _id: { $in: ids } }),
    BranchCommentLike.deleteMany({ comment: { $in: ids } }),
    Notification.deleteMany({
      $or: [{ "payload.commentId": { $in: idKeys } }, { "payload.parentCommentId": { $in: idKeys } }],
    }),
  ]);

  const commentCount = await BranchComment.countDocuments({ video: videoId });
  await BranchVideo.updateOne({ _id: videoId }, { $set: { commentCount } });
  return { removed: Number(removed?.deletedCount || 0), commentCount };
}

/**
 * DELETE /api/branch/videos/:id/comments/:commentId —— 删自己的评论。
 *
 * ★ 三种人能删：**评论作者本人**、**作品作者**（自己作品下的内容得能清理）、
 *   以及**管理员**（作品作者不作为时的兜底，也是举报处理的落点）。
 *   判据只有 assertCanDelete 一处 —— 别在这里另写一遍 `isOwner || isAdmin`。
 * ★ 无权时回 403 而不是 404：这条评论对请求者本来就是可见的（他刚在评论区看见它），
 *   403 一个字节的新信息都没多给。反过来，弹幕那条必须小心得多 —— 见 removeDanmaku。
 */
async function removeComment(req, res, next) {
  try {
    const { id, commentId } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    if (!isValidId(commentId)) invalidId("Invalid comment id");

    // 可见性先过一道：看不见的作品下的评论对你就是"不存在"（与 loadVisibleComment 同一条规则）。
    // ★ 要 select author：下面判"是不是作品作者"要用它。
    // ★ 管理员在 assertVisible 里越过可见性，所以已下架/私密作品下的评论他也清理得掉 ——
    //   否则"下架 + 清评论"这套组合动作会在第二步卡住。
    const video = await assertVisible(id, req.user, "_id author");

    const comment = await BranchComment.findById(commentId).select("_id video author").lean();
    // 评论 id 是全局唯一的，只按 id 查就绕开了作品的可见性 —— 必须核对归属（同 loadVisibleComment）
    if (!comment || String(comment.video) !== String(id)) notFound("Comment not found");

    const by = assertCanDelete(req.user, comment.author, video.author);
    if (by === "admin") {
      console.warn(
        `[branch] 管理员删除评论 video=${id} comment=${commentId} author=${comment.author} admin=${req.user._id}`
      );
    }

    const { removed, commentCount } = await purgeComments(id, comment._id);
    res.json({ ok: true, removed, commentCount });
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
 * ★ 条件写进**查询**而不是取出来再判，除了省一次往返，还挡掉一类静默失效：
 *   调用方给的 select 里少一列（比如没 select visibility / takedown），
 *   取出来再判就会把 undefined 当成"可见"，闸门一个错都不报地失效。
 *
 * ★★ 管理员在这里越过全部条件。这是**按 id 直取**才有的特权，理由是后台要干三件事：
 *   审一条被举报的作品、在已下架/私密作品下清理评论与弹幕、以及下架之后还能再看一眼。
 *   列表那条路（readableFilter）**不给**这个特权 —— 管理员刷首页不该看到全站的私密作品。
 */
async function assertVisible(id, user, select = "_id") {
  // ★ 按 id 取 ⇒ 用**按 id 的**口径（认「凭链接可见」）。用列表口径的话，
  //   拿到链接的人点赞/评论/弹幕/播放全是静默 404 —— 见 readableByIdFilter 的 ★★。
  const filter = isAdmin(user) ? { _id: id } : { $and: [{ _id: id }, readableByIdFilter(user)] };
  const doc = await BranchVideo.findOne(filter).select(select).lean();
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

/**
 * DELETE /api/branch/videos/:id/danmaku/:danmakuId —— 删自己的弹幕。
 *
 * ★ 能删的三种人与评论一致：**弹幕作者本人**、**作品作者**、**管理员**
 *   （判据同样只有 assertCanDelete 一处）。
 *
 * ★★ 回包与错误文案**一个字都不许透出作者是谁**（契约里写死了弹幕对外只有一个 `mine`
 *   布尔）。挂上作者，一条作品的弹幕墙就成了"谁在什么时间看了这个视频"的公开记录 ——
 *   而"删除"这条路是最容易顺手漏出去的：随手回一个
 *   `403 这条弹幕属于 xxx` 就等于给整面弹幕墙开了一个逐条查作者的接口
 *   （对每条弹幕试删一次即可）。所以这里只回 `Forbidden` 四个字。
 * ★ 为什么 403 就够、不必回 404 装作不存在：请求者本来就能从列表里的 `mine: false`
 *   知道"这条不是我发的"，403 没有多给任何信息。真正要守的是**不说出是谁**。
 *
 * ★ 回包刻意**不带剩余条数**：弹幕列表是采样的（最新 N 条），给一个数只会让客户端
 *   以为那是"全部"。客户端要同步内存里那份，删掉本地那条即可。
 */
async function removeDanmaku(req, res, next) {
  try {
    const { id, danmakuId } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");
    if (!isValidId(danmakuId)) invalidId("Invalid danmaku id");

    const video = await assertVisible(id, req.user, "_id author");

    // 与评论同理：弹幕 id 全局唯一，必须连 video 一起查，否则就是绕开可见性的旁路
    const danmaku = await BranchDanmaku.findOne({ _id: danmakuId, video: id }).select("_id author").lean();
    if (!danmaku) notFound("Danmaku not found");

    // ⚠ assertCanDelete 抛的是不带任何主人信息的 `Forbidden` —— 这条端点必须如此
    //   （回一句"这条属于 xxx"就等于给整面弹幕墙开了逐条查作者的接口）。
    const by = assertCanDelete(req.user, danmaku.author, video.author);
    if (by === "admin") {
      // ★ 日志里可以写作者是谁：日志是我们自己看的，回包才是对外的。两者不要混为一谈。
      console.warn(
        `[branch] 管理员删除弹幕 video=${id} danmaku=${danmakuId} author=${danmaku.author} admin=${req.user._id}`
      );
    }

    await BranchDanmaku.deleteOne({ _id: danmaku._id });
    // 弹幕不发通知（契约「通知」一节），所以没有指向它的收件箱记录要清 ——
    // 这不是遗漏：发通知等于把匿名的弹幕去匿名化。
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ── 管理端点（全部要求 role=admin，门在路由上）──────────────────────────
//
// ★★ 为什么下架是**另一个字段**而不是把 visibility 改成 private：
//   visibility 是作者自己的开关，`updateVideo` 只校验"是不是作者" —— 作者一个 PATCH
//   就能把自己改回 public。用它当下架等于给了被下架的人一个"撤销下架"按钮。
//   （而且语义也不对：private 的意思是"仅作者可见"，作者照样看得见，
//    首页少了一条对他来说毫无解释。）
//
// ★ 这几条挂在 **/api/admin/branch**（routes/branchAdmin.routes.js），
//   与举报那条线的 /api/admin/branch/reports 同一个前缀 —— 后台控制台只用记一个 base。
//   ⚠ 硬删除**不在这里另开一条**：DELETE /api/branch/videos/:id 已经放行管理员了
//     （assertCanDelete 一处判据）。同一件事两条路径，迟早有一条被改漏。

/** 下架原因的长度上限。与模型里 takedownSchema.reason 的 maxlength 同一个数（铁律六） */
const TAKEDOWN_REASON_MAX = 500;

/**
 * 下架/撤销下架的**唯一写入点**。两个调用方：
 *   ① 管理端点 takedownVideo / revokeTakedown（本文件）
 *   ② 举报处理 action=takedown（services/takedown.service → report.controller）
 * ★ 在②那边另写一遍 `$set: { takedown: ... }` 的话，字段形状迟早分叉
 *   （比如漏了 at，于是那条作品在"已下架"的判据下反而是可见的 —— 还不报错）。
 *
 * @param {boolean} on true = 下架；false = 撤销
 * @returns {Promise<object|null>} 更新后的文档（已 populate 作者）；作品不存在 → null
 */
async function applyTakedown(videoId, { by, reason = "", on = true } = {}) {
  // ★ 撤销必须 $unset（整个子文档删掉），不能 $set null —— 理由见 TAKEN_DOWN 的说明
  const update = on
    ? { $set: { takedown: { by, at: new Date(), reason: String(reason).slice(0, TAKEDOWN_REASON_MAX) } } }
    : { $unset: { takedown: "" } };
  return BranchVideo.findByIdAndUpdate(videoId, update, { returnDocument: "after" })
    .populate("author", AUTHOR_FIELDS)
    .lean();
}

/**
 * POST /api/admin/branch/videos/:id/takedown —— 下架一条作品（可逆）。
 *
 * ★ reason **必填**。作者会看到这句话；空原因等于"你的作品消失了，不告诉你为什么"，
 *   用户唯一的下一步就是原样再发一遍。
 * ★ 重复下架不报错，只是把 by/at/reason 覆盖成最新的一次 —— 后台重复点、
 *   或者换个原因重下，都不该失败。
 * ★ body 的校验放在这里而不是 schemas/branchVideo.schemas.js：这条端点只有一个短字符串
 *   要判，也不走 validate 中间件（列表 query 同理，见 listVideos）。
 *   要收进那份 schema 就把这一整段挪过去，别在两边各留一份（铁律六）。
 */
async function takedownVideo(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const reason = String(req.body?.reason ?? "").trim();
    if (!reason) badRequest("reason is required");
    if (reason.length > TAKEDOWN_REASON_MAX) badRequest(`reason too long (max ${TAKEDOWN_REASON_MAX})`);

    const updated = await applyTakedown(id, { by: req.user._id, reason, on: true });
    if (!updated) notFound("Video not found");

    console.warn(
      `[branch] 管理员下架作品 video=${id} author=${updated.author?._id || updated.author} ` +
        `admin=${req.user._id} reason=${reason.slice(0, 80)}`
    );

    res.json({ ok: true, video: toVideoPayload(updated, { isOwner: ownedBy(updated, req.user), admin: true }) });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/admin/branch/videos/:id/takedown —— 撤销下架。
 *
 * ★★ 必须用 `$unset` 把整个子文档删掉，**不能** `$set: { takedown: null }`：
 *   过滤条件判的是 `takedown.at` 存不存在，写成 null 时这条恰好也判成"没下架"、
 *   看起来能用 —— 但库里会留下一堆半截记录，partial 索引也认不出它们。
 *   一个字段只有两种状态：有，或者没有。
 * ★ 对一条本来就没下架的作品调这个端点：直接成功（幂等）。回 404/400 只会让
 *   后台在"到底下没下"这件事上多一轮往返，而结果是一样的。
 */
async function revokeTakedown(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid video id");

    const updated = await applyTakedown(id, { on: false });
    if (!updated) notFound("Video not found");

    console.warn(`[branch] 管理员撤销下架 video=${id} admin=${req.user._id}`);

    res.json({ ok: true, video: toVideoPayload(updated, { isOwner: ownedBy(updated, req.user), admin: true }) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/branch/takedowns —— 列出当前被下架的作品（最近的在前）。
 *
 * ★ 没有这条的话"撤销下架"就是个找不到入口的功能：管理员手里只有一个 videoId
 *   （从举报里来的），下完架就再也列不出来了 —— 被误下架的作品会永远躺在那儿。
 * ★ 走 `TAKEN_DOWN` 这一份条件 + 模型里那条 partial 索引，不要在这里另写一遍条件。
 */
async function listTakedowns(req, res, next) {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.trunc(raw))) : 20;

    const docs = await BranchVideo.find(TAKEN_DOWN)
      .sort({ "takedown.at": -1 })
      .limit(limit)
      .populate("author", AUTHOR_FIELDS)
      .lean();

    res.json({ ok: true, items: docs.map((d) => toVideoPayload(d, { admin: true })) });
  } catch (err) {
    next(err);
  }
}

/**
 * 待处理举报数。举报是**另一条线**的功能（models/Report.js + routes/report.routes.js）。
 *
 * ★ 用 try/require + "只吞自己不存在"：那条线还没落地的部署上（或者以后有人把它拆走），
 *   裸 require 会抛 MODULE_NOT_FOUND 把整个统计端点炸成 500 —— 一个不在的功能
 *   不该让已经上线的看板打不开。同一招用在 branchVideo.routes 引 branchAsset.routes 上。
 *   ⚠ 只吞"这个模块不存在"，模块自己内部的报错必须原样抛出去：否则那边写错一行 require，
 *   表现会变成"举报数永远是 —"，谁也查不到为什么。
 * ★ 问不到时回 **null 而不是 0**：0 的意思是"没有待处理的举报"，null 的意思是
 *   "这台服务端没有举报功能"。合成一个数字就是在骗人（铁律八）——
 *   后台该把 null 画成 "—"，而不是一个让人放心的零。
 * ★ `status: "pending"` 与 models/Report.js 的 STATUSES 同源（那份枚举里 pending 是
 *   唯一的"未处理"）。那边改了状态名，这里跟着改**一处**。
 */
let ReportModel; // undefined = 还没探测过；null = 探测过、不存在
function loadReportModel() {
  if (ReportModel !== undefined) return ReportModel;
  try {
    ReportModel = require("../models/Report");
  } catch (err) {
    const selfMissing =
      err && err.code === "MODULE_NOT_FOUND" && /models[\\/]Report/.test(String(err.message || ""));
    if (!selfMissing) throw err;
    console.warn("[branch] models/Report 未就绪，平台统计里的待处理举报数将回 null");
    ReportModel = null;
  }
  return ReportModel;
}

async function pendingReportCount() {
  const Report = loadReportModel();
  if (!Report) return null;
  try {
    return await Report.countDocuments({ status: "pending" });
  } catch (err) {
    // 字段名对不上（比如状态那一档改了名）时不该把整个看板拖垮，但必须留痕
    console.error("[branch] 待处理举报数查询失败:", err?.message || err);
    return null;
  }
}

/**
 * GET /api/admin/branch/stats —— 平台数据（最小可用的一屏）。
 *
 * ★ 一律 `countDocuments`，绝不 `find().length`：这几张表是会长到百万级的
 *   （弹幕尤其），把整表捞进内存数一遍会把进程直接顶死，而且是在"后台看一眼数据"
 *   这种最不该出事的场景下。
 * ★ 用 countDocuments 而不是 estimatedDocumentCount：后者读的是集合元数据，
 *   不接受查询条件（takedown 那一项就没法数），而且分片/异常关机后会偏。
 *   这几张表的量级下，一次带索引的 count 完全够快。
 */
async function branchStats(req, res, next) {
  try {
    const [users, banned, videos, takenDown, comments, danmaku] = await Promise.all([
      User.countDocuments({}),
      // 封禁判据的查询侧写法在 utils/banned.js 一处（与 TAKEN_DOWN 同一种收口）
      User.countDocuments(BANNED_FILTER),
      BranchVideo.countDocuments({}),
      BranchVideo.countDocuments(TAKEN_DOWN),
      BranchComment.countDocuments({}),
      BranchDanmaku.countDocuments({}),
    ]);
    const pendingReports = await pendingReportCount();

    res.json({
      ok: true,
      // banned 是后加的键：老 App 读不到就当没有（只加不减，铁律七）
      stats: { users, banned, videos, takenDown, comments, danmaku, pendingReports },
    });
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
  takedownVideo,
  revokeTakedown,
  listTakedowns,
  branchStats,
  addPlay,
  likeVideo,
  unlikeVideo,
  listComments,
  addComment,
  removeComment,
  likeComment,
  unlikeComment,
  listDanmaku,
  addDanmaku,
  removeDanmaku,
  // ★ 给 services/takedown.service.js（举报处理那条线的落点）复用的三样。
  //   下架与清理的实现只有这一份 —— 那边**只调用，不重写**（铁律六）。
  applyTakedown,
  purgeVideo,
  purgeComments,
  // ★ 给 branchAdmin.controller（用户管理 / 内容钻取）复用的几样，同一条铁律：
  //   序列化（toVideoPayload）、「已下架」的库内判据（TAKEN_DOWN 那一对）、
  //   点赞计数回写（syncLikes / syncCommentLikes —— 级联删用户时，他点过的赞
  //   要从别人的作品/评论上撤走并把快照重算回来）。那边**只调用，不重写**。
  toVideoPayload,
  TAKEN_DOWN,
  NOT_TAKEN_DOWN,
  syncLikes,
  syncCommentLikes,
  AUTHOR_FIELDS,
  // 导出给测试/其它模块复用
  transferDraftAssets,
  isArkVideoUrl,
};
