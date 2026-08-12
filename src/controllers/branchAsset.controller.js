// src/controllers/branchAsset.controller.js
// 分支视频 · 卡片与卡组控制器。
// 卡片：我的列表 / 批量新增（按 { owner, cardId } 幂等，已存在直接跳过）/ 删除（同时从所有卡组里摘除）。
// 卡组：我的列表 / 建组 / 改名改卡 / 删组，全部做归属校验。
// 卡面 cover 可能是 Seedream 出图的 dataURL，入库前转存 Cloudinary 拿永久 URL；
// 单张转存失败降级保留原值并 warn，不阻断整批。
const crypto = require("crypto");
const mongoose = require("mongoose");
const BranchCard = require("../models/BranchCard");
const BranchDeck = require("../models/BranchDeck");
const BranchAssetStat = require("../models/BranchAssetStat");
const BranchAssetLike = require("../models/BranchAssetLike");
const BranchAssetView = require("../models/BranchAssetView");
const { uploadToCloudinary } = require("../middleware/upload");
// ★ 取访客 IP 只有一处实现（那段注释解释了为什么 req.ip 是错的答案）
const { clientIp } = require("../middleware/rateLimit");
const { forbidden, notFound, invalidId, badRequest } = require("../utils/http");
// 热度只有一份公式（想法榜也调它），见 utils/hotScore.js 的说明
const { hotScore, roundHeat } = require("../utils/hotScore");
const {
  assetKey: assetKeySchema,
  assetKind: assetKindSchema,
  CARD_VIEW_KINDS,
  MAX_CARD_VIEWS,
  isShareableViewUrl,
} = require("../schemas/branchAsset.schemas");
const { searchRegex } = require("../utils/regex");

const CLOUDINARY_FOLDER = "branch-cards";
// 单张卡面解码后的上限：超过就不折腾 Cloudinary
const MAX_COVER_BYTES = 10 * 1024 * 1024;
// 转存失败时，超过该长度的 dataURL 不再内联落库。
// 与 branchVideo.controller.js 的 MAX_INLINE_FALLBACK 同一套策略、同一个环境变量：
// 没配 Cloudinary 时每张卡都带着 MB 级 base64 入库，GET /cards 一次性返回全部卡面，
// 响应体能到几十 MB。
const MAX_INLINE_FALLBACK = Number(process.env.BRANCH_INLINE_FALLBACK_MAX || 512 * 1024);
// 批量转存的并发度：太高容易被 Cloudinary 限流，太低批量加卡会很慢
const UPLOAD_CONCURRENCY = 4;
const MAX_DECK_CARD_IDS = 500;

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

// ── 互动计数与热度 ────────────────────────────────────────────────

const EMPTY_STATS = Object.freeze({ views: 0, likes: 0, bookmarks: 0, heat: 0 });

/**
 * 一条 BranchAssetStat → 响应里的 stats。
 * ★ commentCount 恒传 0：卡片/卡组的评论**目前只存在客户端**（app 的 data/social.ts），
 *   服务端没有这张表。传一个假的评论数比不传更糟——那会让热度看起来"算过评论"。
 *   以后真做了服务端评论，只要在这里把数喂进去，公式本身一个字都不用动。
 */
function statsPayload(row) {
  const views = Number(row?.views || 0);
  const likes = Number(row?.likes || 0);
  const bookmarks = Number(row?.bookmarks || 0);
  return {
    views,
    likes,
    bookmarks,
    heat: roundHeat(hotScore({ likeCount: likes, bookmarkCount: bookmarks, viewCount: views, commentCount: 0 })),
  };
}

/** 批量取一组 key 的计数，返回 Map<key, stats>。没有记录的 key 不在 Map 里（调用方兜 EMPTY_STATS） */
async function loadStats(kind, keys) {
  const uniq = [...new Set(keys.filter(Boolean).map(String))];
  if (!uniq.length) return new Map();
  const rows = await BranchAssetStat.find({ kind, key: { $in: uniq } }).lean();
  return new Map(rows.map((r) => [r.key, statsPayload(r)]));
}

// ── 多图参考（views）的唯一闸门 ───────────────────────────────────
/**
 * 一批 views → 能存下来、也能发出去的那几张。**入库、快照、安装、回包全走这一个函数**。
 *
 * ★ 为什么读的时候也过一遍（而不是"入库时干净了就直接吐出去"）：这是同一条规则的
 *   同一处实现，多调几次代价是零；而分成"入口一份、出口一份"的写法，两边一旦分叉
 *   （比如以后放宽了入口），出口那份会把用户真实存着的图**静默少给几张** —— 卡片
 *   详情页上看不出少了，只有生成出来的人物"有点不像"，没人查得到这里。
 *
 * ⚠ 这里**不做**第三方版权判断（isThirdPartyModel 那套）：views 是 Seedream 出的图，
 *   是我们自己的产物，不是 BOOTH 购入的模型。挡的只有"发出去对别人没意义"的地址。
 */
function shareableViews(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const url = String(item?.url || "").trim().slice(0, 2000);
    // 同一张图挂两次没有意义，还会挤掉真正该带上的第 3 张（方舟按图片顺序编号引用）
    if (!isShareableViewUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      // 认不出的 kind 退 "detail" 而不是丢掉这张图：kind 只影响提示词里怎么描述它
      // （face=面部特征 / body=服装与体型），退成中性的说法仍然有用，丢掉就真没了
      kind: CARD_VIEW_KINDS.includes(item?.kind) ? item.kind : "detail",
      note: String(item?.note || "").trim().slice(0, 200),
    });
    if (out.length >= MAX_CARD_VIEWS) break;
  }
  return out;
}

// ── 序列化 ────────────────────────────────────────────────────────
// 客户端 Card 形状是 { id, type, name, summary, cover, hot?, tags?, modelUrl?, genPrompt?, views? }，
// 这里同时给出 id 与 cardId，前端两种写法都能直接吃。
function toCardPayload(doc, stats = EMPTY_STATS) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: doc.cardId,
    cardId: doc.cardId,
    type: doc.type,
    name: doc.name || "",
    summary: doc.summary || "",
    cover: doc.cover || "",
    // ⚠ hot 是客户端发来的种子值，**不是**热度的判据。真热度看 stats.heat
    hot: Number(doc.hot || 0),
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    modelUrl: doc.modelUrl || "",
    genPrompt: doc.genPrompt || "",
    // ★ 老卡这里是空数组。**不在服务端补"拿 cover 当唯一一张图"** —— 那份归一
    //   只在 app 的 viewsOf() 一处做（理由见 models/BranchCard.js 的字段注释）。
    views: shareableViews(doc.views),
    published: !!doc.published,
    publishedAt: doc.publishedAt,
    description: doc.description || "",
    stats,
    createdAt: doc.createdAt,
  };
}

function toDeckPayload(doc, stats = EMPTY_STATS) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: String(doc._id),
    name: doc.name || "",
    cardIds: Array.isArray(doc.cardIds) ? doc.cardIds : [],
    coverCardId: doc.coverCardId || "",
    published: !!doc.published,
    publishedAt: doc.publishedAt,
    description: doc.description || "",
    installs: Number(doc.installs || 0),
    sourceDeck: doc.sourceDeck ? String(doc.sourceDeck) : undefined,
    stats,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** 广场里的一条：不返回完整 cards 快照（列表会很大），只给张数和前几张封面 */
function toSharedDeckPayload(doc, stats = EMPTY_STATS) {
  if (!doc) return null;
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  return {
    _id: doc._id,
    id: String(doc._id),
    name: doc.name || "",
    description: doc.description || "",
    cardCount: cards.length,
    covers: cards.slice(0, 4).map((c) => c.cover).filter(Boolean),
    types: [...new Set(cards.map((c) => c.type))],
    installs: Number(doc.installs || 0),
    author: doc.owner && typeof doc.owner === "object" ? doc.owner : undefined,
    stats,
    publishedAt: doc.publishedAt,
  };
}

// ── 卡面转存 ──────────────────────────────────────────────────────

function isDataUrl(value) {
  return /^data:[^;,]*;base64,/i.test(value);
}

// uploadToCloudinary 内部 public_id = `${userId}-${Date.now()}`，
// 批量并发上传同一毫秒会撞 id 互相覆盖，所以把 cardId + 随机串拼进去当"用户标识"。
function uploadTag(userId, cardId) {
  const slug = String(cardId || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return [String(userId), slug, rand].filter(Boolean).join("-");
}

/** 转存失败的降级值：过大的 dataURL 不内联落库（与 branchVideo 侧同策略） */
function fallbackCover(original, cardId) {
  const raw = String(original || "");
  if (isDataUrl(raw) && raw.length > MAX_INLINE_FALLBACK) {
    console.warn(`[branchAsset] cover 转存失败且 dataURL 过大(${raw.length}B)，已丢弃内联数据: ${cardId}`);
    return "";
  }
  return raw;
}

/**
 * dataURL → Cloudinary 永久 URL；http(s) 或空值原样返回。
 * 任何失败都降级（warn 一条）不抛错——但大 dataURL 会被丢掉而不是原样入库。
 */
async function transferCover(rawCover, userId, cardId) {
  const cover = typeof rawCover === "string" ? rawCover.trim() : "";
  if (!cover || !isDataUrl(cover)) return cover; // 已是外链/空 → 原样保留

  try {
    const base64 = cover.slice(cover.indexOf(",") + 1);
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) return "";
    if (buffer.length > MAX_COVER_BYTES) {
      console.warn(`[branchAsset] cover too large (${buffer.length}B): ${cardId}`);
      return fallbackCover(cover, cardId);
    }
    const url = await uploadToCloudinary(buffer, CLOUDINARY_FOLDER, uploadTag(userId, cardId));
    return url || fallbackCover(cover, cardId);
  } catch (err) {
    console.warn(`[branchAsset] cover transfer failed for ${cardId}:`, err?.message || err);
    return fallbackCover(cover, cardId);
  }
}

// 限并发地跑一批异步任务，保持结果顺序
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── 3D 建模的分发闸门 ─────────────────────────────────────────────
//
// ★★ 这里挡两件**性质完全不同**的事，都不能漏：
//
//  1) 设备本地指针（`idb:model3d:*`）。它指的是**卡主那台机器**的 IndexedDB，
//     换个人拿到就是个死链。放行的后果不是报错，是"卡片详情页答应了全息预览、
//     实际什么都不显示"——比不给更糟。所以只放行 http(s)。
//
//  2) **第三方版权模型**。仓库里 `/models/protected/` 下放的是"要加密的"，
//     不是"不能发的"——两件事：milltina 是委托定制的自有资产（必须随包发），
//     rin / gratia / tsumire 是 BOOTH 购入的第三方素材，**再配布需要授权**
//     （见 app 仓 design/README-tsumire.md）。用户如果把这类路径挂到卡上再分享，
//     就等于我们替他把版权素材发出去了。加密拦不住版权——密钥就在同一个包里。
//
// ⚠ app 仓 src/types.ts 里有一份同语义的 publishableModelUrl()，用于在**按下按钮之前**
//   告诉用户"这张卡的建模不会跟着走"。两仓不在一个 CI 里，只能各留一份（同定价表的处境）；
//   改这条规则时两边一起改。服务端这份是**权威**的那份。
const THIRD_PARTY_MODEL_RE = /\/models\/protected\//i;
// 自有资产例外：委托定制的默认铸卡师，就住在同一个加密目录里
const OWN_WORK_MODEL_RE = /milltina/i;

function isThirdPartyModel(raw) {
  const url = String(raw || "");
  return THIRD_PARTY_MODEL_RE.test(url) && !OWN_WORK_MODEL_RE.test(url);
}

/** 可以跟着卡片发出去的 modelUrl；不合格返回空串（调用方据此不给别人这条）。
 *  ⚠ 多图参考（views）**不走这个函数**，它有自己的闸门 shareableViews()：
 *    第三方版权那一半对 views 不成立（那是我们自己 Seedream 出的图）。 */
function shareableModelUrl(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\//i.test(url)) return ""; // idb:/相对路径/空 —— 对别人没有意义
  if (isThirdPartyModel(url)) return "";
  return url;
}

function normalizeCardIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_DECK_CARD_IDS) break;
  }
  return out;
}

// ── 卡片 ──────────────────────────────────────────────────────────

// GET /cards
async function listCards(req, res, next) {
  try {
    const docs = await BranchCard.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
    const stats = await loadStats("card", docs.map((d) => d.cardId));
    res.json({ ok: true, cards: docs.map((d) => toCardPayload(d, stats.get(d.cardId) || EMPTY_STATS)) });
  } catch (err) {
    next(err);
  }
}

// POST /cards —— 批量幂等新增：{ cards: Card[] }
async function addCards(req, res, next) {
  try {
    const owner = req.user._id;

    // 1) 规整 + 批内去重（同一批里重复的 cardId 只留第一条）
    const seen = new Set();
    const incoming = [];
    for (const raw of req.body.cards || []) {
      const cardId = String(raw.cardId || raw.id || "").trim();
      if (!cardId || seen.has(cardId)) continue;
      seen.add(cardId);
      incoming.push({
        cardId,
        type: raw.type || "prop",
        name: String(raw.name || "").trim().slice(0, 120),
        summary: String(raw.summary || "").trim().slice(0, 2000),
        cover: typeof raw.cover === "string" ? raw.cover : "",
        hot: Number.isFinite(Number(raw.hot)) ? Math.max(0, Math.trunc(Number(raw.hot))) : 0,
        tags: Array.isArray(raw.tags)
          ? [...new Set(raw.tags.map((t) => String(t || "").trim()).filter(Boolean))].slice(0, 12)
          : [],
        // ★ 这两个字段原来在 schema 与 model 里都没有，于是「客户端发了、服务端 201 了、
        //   读回来是空的」。modelUrl 这里**原样收**（可能是 idb: 本地指针，那是卡主
        //   自己那份记录的一部分）；发布/安装时才由 shareableModelUrl 剥掉。
        modelUrl: typeof raw.modelUrl === "string" ? raw.modelUrl.slice(0, 2000) : "",
        genPrompt: typeof raw.genPrompt === "string" ? raw.genPrompt.slice(0, 4000) : "",
        // ★ 越界的 views 在 zod 那层就已经 400 了（超过 3 张 / 非 http(s)），
        //   这里只做去重与归一，不承担"拒绝"的职责。
        views: shareableViews(raw.views),
      });
    }

    if (!incoming.length) {
      return res.status(201).json({ ok: true, cards: [], added: 0, skipped: 0, skippedIds: [] });
    }

    // 2) 已存在的直接跳过（顺带省掉这些卡的转存开销）
    const existing = await BranchCard.find({
      owner,
      cardId: { $in: incoming.map((c) => c.cardId) },
    })
      .select("cardId")
      .lean();
    const existingIds = new Set(existing.map((x) => x.cardId));
    const fresh = incoming.filter((c) => !existingIds.has(c.cardId));
    const skippedIds = incoming.filter((c) => existingIds.has(c.cardId)).map((c) => c.cardId);

    if (!fresh.length) {
      return res.status(201).json({
        ok: true,
        cards: [],
        added: 0,
        skipped: skippedIds.length,
        skippedIds,
      });
    }

    // 3) 只给新卡转存封面（dataURL → Cloudinary），失败降级保留原值
    const covers = await mapWithConcurrency(fresh, UPLOAD_CONCURRENCY, (card) =>
      transferCover(card.cover, owner, card.cardId)
    );
    fresh.forEach((card, i) => {
      card.cover = covers[i];
    });

    // 4) upsert + $setOnInsert：即使并发重复提交也只会插一条，已存在的字段一个不动
    const now = new Date();
    const ops = fresh.map((card) => ({
      updateOne: {
        filter: { owner, cardId: card.cardId },
        update: { $setOnInsert: { owner, createdAt: now, ...card } },
        upsert: true,
      },
    }));

    let upsertedCount = 0;
    try {
      const result = await BranchCard.bulkWrite(ops, { ordered: false });
      upsertedCount = Number(result?.upsertedCount || 0);
    } catch (err) {
      // 并发下唯一索引撞车（E11000）就是"已存在" → 幂等语义下当跳过处理，其余错误照抛
      const writeErrors = err?.writeErrors || err?.result?.writeErrors || [];
      const onlyDupes = writeErrors.length > 0 && writeErrors.every((e) => (e?.code ?? e?.err?.code) === 11000);
      if (!onlyDupes && err?.code !== 11000) throw err;
      upsertedCount = Number(err?.result?.upsertedCount ?? err?.result?.nUpserted ?? 0);
    }

    // 回读真正落库的这批（含被并发抢先插入的），返回给客户端对齐本地缓存
    const saved = await BranchCard.find({ owner, cardId: { $in: fresh.map((c) => c.cardId) } })
      .sort({ createdAt: -1 })
      .lean();
    const stats = await loadStats("card", saved.map((c) => c.cardId));

    res.status(201).json({
      ok: true,
      cards: saved.map((c) => toCardPayload(c, stats.get(c.cardId) || EMPTY_STATS)),
      added: upsertedCount,
      skipped: skippedIds.length,
      skippedIds,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /cards/:cardId —— 删卡，并从该用户所有卡组里摘掉
// PATCH /cards/:cardId（requireAuth）—— 改自己那张卡的多图参考（views）。
// ★★ 这条端点存在的全部理由：POST /cards 是 `$setOnInsert`（新增语义），拿它改卡
//   会 201 得漂漂亮亮、库里一个字节没变；而客户端每次登录都用服务端那份整体覆盖
//   本地卡库 —— 用户加的参考图会在下一次冷启动时无声消失（见 schemas 里的说明）。
// ★ 卡不在（只存在于本地、或换了账号）一律 404，让客户端把原因显红字。返回 200
//   假装存上了，是把"没同步"变成"以为同步了"，那才是真的丢数据（铁律八）。
async function updateCard(req, res, next) {
  try {
    const owner = req.user._id;
    const cardId = String(req.params.cardId || "").trim();
    if (!cardId) invalidId("Invalid card id");

    const doc = await BranchCard.findOneAndUpdate(
      { owner, cardId },
      // 去重与归一走与入库/发布同一个闸门，别在这里另写一遍（铁律六）
      { $set: { views: shareableViews(req.body.views) } },
      { new: true }
    ).lean();
    if (!doc) notFound("card not found");

    res.json({ ok: true, card: toCardPayload(doc) });
  } catch (err) {
    next(err);
  }
}

async function removeCard(req, res, next) {
  try {
    const owner = req.user._id;
    const cardId = String(req.params.cardId || "").trim();
    if (!cardId) invalidId("Invalid card id");

    const result = await BranchCard.deleteOne({ owner, cardId });
    // 不管卡片在不在，都清一遍卡组引用，避免历史脏数据留悬空 id
    await BranchDeck.updateMany({ owner, cardIds: cardId }, { $pull: { cardIds: cardId } });

    res.json({ ok: true, removed: Number(result?.deletedCount || 0) > 0, cardId });
  } catch (err) {
    next(err);
  }
}

// ── 卡组 ──────────────────────────────────────────────────────────

// GET /decks
async function listDecks(req, res, next) {
  try {
    const docs = await BranchDeck.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
    const stats = await loadStats("deck", docs.map((d) => String(d._id)));
    res.json({ ok: true, decks: docs.map((d) => toDeckPayload(d, stats.get(String(d._id)) || EMPTY_STATS)) });
  } catch (err) {
    next(err);
  }
}

// POST /decks —— { name, cardIds? }
async function createDeck(req, res, next) {
  try {
    const name = String(req.body.name || "").trim().slice(0, 60) || "未命名卡组";
    const cardIds = normalizeCardIds(req.body.cardIds);

    const doc = await BranchDeck.create({ owner: req.user._id, name, cardIds });
    res.status(201).json({ ok: true, deck: toDeckPayload(doc.toObject()) });
  } catch (err) {
    next(err);
  }
}

// PATCH /decks/:id —— { name?, cardIds?, coverCardId?, description? }
async function updateDeck(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid deck id");

    const doc = await BranchDeck.findById(id);
    if (!doc) notFound("Deck not found");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.name !== undefined) {
      doc.name = String(req.body.name || "").trim().slice(0, 60) || "未命名卡组";
    }
    if (req.body.cardIds !== undefined) {
      doc.cardIds = normalizeCardIds(req.body.cardIds);
    }
    if (req.body.coverCardId !== undefined) {
      doc.coverCardId = String(req.body.coverCardId || "").trim().slice(0, 120);
    }
    // 卡组简介（客户端叫 intro）。★ 它和「发布时写的 description」是同一个字段：
    //   分成两个的话，用户在详情页写完简介、再点分享，广场里显示的还是空的。
    if (req.body.description !== undefined) {
      doc.description = String(req.body.description || "").trim().slice(0, 200);
    }

    await doc.save();
    const stats = await loadStats("deck", [String(doc._id)]);
    res.json({ ok: true, deck: toDeckPayload(doc.toObject(), stats.get(String(doc._id)) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// DELETE /decks/:id
async function deleteDeck(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid deck id");

    const doc = await BranchDeck.findById(id).select("owner").lean();
    if (!doc) notFound("Deck not found");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");

    await BranchDeck.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ── 卡组分享到创意工坊 ────────────────────────────────────────────

const DECK_AUTHOR_FIELDS = "_id username displayName avatarUrl";

// POST /decks/:id/publish —— { description? }
// 发布时把卡片内容快照进卡组：卡片是 { owner, cardId } 私有的，
// 别人装这套卡组时要给他自己建一份。快照让「装」这件事自包含，
// 也让发布者事后删卡不会把已分享的卡组变成空壳。
async function publishDeck(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid deck id");

    const doc = await BranchDeck.findById(id);
    if (!doc) notFound("Deck not found");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");
    if (!doc.cardIds.length) {
      res.status(400);
      throw new Error("空卡组不能分享");
    }

    const owned = await BranchCard.find({ owner: req.user._id, cardId: { $in: doc.cardIds } }).lean();
    if (!owned.length) {
      res.status(400);
      throw new Error("这套卡组里的卡片都不在了");
    }

    // ★★ 版权闸门，与 publishCard 里那条是**同一条规则、同一种行为**：撞上就 400，
    //   不是"悄悄把这张卡的 modelUrl 剥掉再发出去"。
    //   这里曾经就是后者，而卡组是最不该静默降级的地方 —— 一套卡里有十几张，
    //   剥掉的那张在广场上照样标着"含 3D 全息"，装走的人打开是空的，发布者
    //   完全不知道发生过什么（他收到的是 200）。
    //   报错必须**点名是哪张卡**：卡组里十几张，只说"有第三方模型"等于让用户挨个猜。
    const blocked = owned.find((c) => isThirdPartyModel(c.modelUrl));
    if (blocked) {
      badRequest(`卡组里的「${blocked.name || blocked.cardId}」挂的是第三方版权模型，未获授权前不能分享`);
    }

    // 按卡组里的顺序快照
    const byId = new Map(owned.map((c) => [c.cardId, c]));
    doc.cards = doc.cardIds
      .map((cid) => byId.get(cid))
      .filter(Boolean)
      .map((c) => ({
        cardId: c.cardId,
        type: c.type,
        name: c.name || "",
        summary: c.summary || "",
        cover: c.cover || "",
        tags: Array.isArray(c.tags) ? c.tags : [],
        hot: Number(c.hot || 0),
        // 到这里第三方素材已经被上面那道门挡掉了，shareableModelUrl 在这条路上
        // 只剩「剥掉设备本地指针（idb:）」一件事 —— 那**是**降级而不是拒绝：
        // 本地指针对别人本来就没有任何意义，剥掉它不会少给用户任何东西。
        modelUrl: shareableModelUrl(c.modelUrl),
        genPrompt: c.genPrompt || "",
        // 参考图必须跟着快照走：少了它，装走的人炼出来的人物就不是同一个人
        views: shareableViews(c.views),
      }));
    // ★ 简介**只在这次真给了的时候**才覆盖：客户端的分享按钮调 publishDeck(id) 时
    //   可能不带 description（简介是在卡组详情页单独 PATCH 上来的），
    //   无脑写 `|| ""` 会把用户刚写好的简介一键清空，而且一点错都不报。
    if (req.body && req.body.description !== undefined) {
      doc.description = String(req.body.description || "").trim().slice(0, 200);
    }
    doc.published = true;
    doc.publishedAt = new Date();
    await doc.save();

    const stats = await loadStats("deck", [String(doc._id)]);
    res.json({ ok: true, deck: toDeckPayload(doc.toObject(), stats.get(String(doc._id)) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// DELETE /decks/:id/publish —— 取消分享（快照一并清掉，别白占空间）
async function unpublishDeck(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid deck id");

    const doc = await BranchDeck.findById(id);
    if (!doc) notFound("Deck not found");
    if (String(doc.owner) !== String(req.user._id)) forbidden("Forbidden");

    doc.published = false;
    doc.publishedAt = undefined;
    doc.cards = [];
    await doc.save();

    const stats = await loadStats("deck", [String(doc._id)]);
    res.json({ ok: true, deck: toDeckPayload(doc.toObject(), stats.get(String(doc._id)) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// GET /decks/shared?q=&limit= —— 广场（optionalAuth：不登录也能逛）
// Express 5 的 req.query 是只读 getter，validate({query}) 会静默失效，
// 所以这里显式解析（与 branchVideo 的列表同一处理）。
async function listSharedDecks(req, res, next) {
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const filter = { published: true };
    if (q) {
      // 用户输入直接进正则会被当成模式（比如搜 "(a+)+$" 能把 mongod 的 CPU 打满），
      // 转义收口在 utils/regex.js 一处 —— 仓里原来有 8 份手写的、其中两份是坏的
      const rx = searchRegex(q);
      filter.$or = [{ name: rx }, { description: rx }, { "cards.name": rx }, { "cards.tags": rx }];
    }

    const docs = await BranchDeck.find(filter)
      .sort({ publishedAt: -1 })
      .limit(limit)
      .populate("owner", DECK_AUTHOR_FIELDS)
      // 装来的卡组再分享出去时把出处带上，否则广场会被无署名的转发副本填满
      .populate({ path: "sourceDeck", select: "owner", populate: { path: "owner", select: DECK_AUTHOR_FIELDS } })
      .lean();

    // 已登录时标出「我装过了」和「这是我自己发的」
    let installedSet = new Set();
    if (req.user) {
      const mine = await BranchDeck.find({ owner: req.user._id, sourceDeck: { $ne: null } })
        .select("sourceDeck")
        .lean();
      installedSet = new Set(mine.map((d) => String(d.sourceDeck)));
    }

    const stats = await loadStats("deck", docs.map((d) => String(d._id)));

    res.json({
      ok: true,
      decks: docs.map((d) => ({
        ...toSharedDeckPayload(d, stats.get(String(d._id)) || EMPTY_STATS),
        remixOf: d.sourceDeck && d.sourceDeck.owner ? d.sourceDeck.owner : undefined,
        installed: installedSet.has(String(d._id)),
        isOwner: req.user ? String((d.owner && d.owner._id) || d.owner) === String(req.user._id) : false,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /decks/:id/install —— 把别人分享的卡组装进我的库。
// 幂等：同一个人对同一套源卡组只装一次（{owner, sourceDeck} 唯一索引兜底）。
async function installDeck(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid deck id");

    const src = await BranchDeck.findById(id).lean();
    if (!src || !src.published) notFound("Deck not found");
    if (String(src.owner) === String(req.user._id)) {
      res.status(400);
      throw new Error("这是你自己分享的卡组");
    }

    const owner = req.user._id;
    const existing = await BranchDeck.findOne({ owner, sourceDeck: src._id }).lean();
    if (existing) {
      return res.json({ ok: true, deck: toDeckPayload(existing), cards: [], alreadyInstalled: true });
    }

    // 1) 快照里的卡 upsert 进我的卡库（已有的同 cardId 不覆盖）
    const snap = Array.isArray(src.cards) ? src.cards : [];
    if (snap.length) {
      await BranchCard.bulkWrite(
        snap.map((c) => ({
          updateOne: {
            filter: { owner, cardId: c.cardId },
            update: {
              $setOnInsert: {
                owner,
                cardId: c.cardId,
                type: c.type,
                name: c.name,
                summary: c.summary,
                cover: c.cover,
                tags: c.tags,
                hot: c.hot,
                // ★ 这里是**兜底**不是规则：发布时（publishDeck）第三方素材已经 400 挡掉了，
                //   但 2026-08-11 之前发布的老卡组快照是"悄悄剥掉"那套逻辑的产物，
                //   里面可能还留着不该跟着走的地址。对已经躺在库里的存量数据，
                //   剥掉是唯一能做的事 —— 拒绝安装只会让用户装不了一套他没参与制作的卡组。
                modelUrl: shareableModelUrl(c.modelUrl),
                genPrompt: c.genPrompt || "",
                views: shareableViews(c.views),
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }

    // 2) 建我自己的卡组
    let deck;
    try {
      deck = await BranchDeck.create({
        owner,
        name: src.name,
        cardIds: snap.map((c) => c.cardId),
        coverCardId: src.coverCardId || "",
        description: src.description || "",
        sourceDeck: src._id,
      });
    } catch (e) {
      if (e && e.code === 11000) {
        const dup = await BranchDeck.findOne({ owner, sourceDeck: src._id }).lean();
        if (dup) return res.json({ ok: true, deck: toDeckPayload(dup), cards: [], alreadyInstalled: true });
      }
      throw e;
    }

    await BranchDeck.updateOne({ _id: src._id }, { $inc: { installs: 1 } });

    const cards = await BranchCard.find({ owner, cardId: { $in: snap.map((c) => c.cardId) } }).lean();
    const cardStats = await loadStats("card", cards.map((c) => c.cardId));
    res.status(201).json({
      ok: true,
      deck: toDeckPayload(deck.toObject()),
      cards: cards.map((c) => toCardPayload(c, cardStats.get(c.cardId) || EMPTY_STATS)),
    });
  } catch (err) {
    next(err);
  }
}

// ── 卡片分享到创意工坊 ────────────────────────────────────────────
//
// 与卡组那套语义一致（published / publishedAt / description），但**没有快照**：
// 一张卡就是它自己，别人装走时直接按 { owner, cardId } 复制一份。
// 快照存在的理由（"发布者删卡不能让已分享的卡组变空壳"）在单卡这里不成立 ——
// 卡没了就是没了，广场上那条自然也该消失。

const CARD_AUTHOR_FIELDS = DECK_AUTHOR_FIELDS;

/**
 * ★★ 「同一张卡的权威那份」的唯一定义：**最早发布**的那条（谁先分享算谁的），
 *    同毫秒按 _id 兜底，保证任何时候都只有一个答案。
 *
 *    为什么必须有这个定义：BranchCard 的唯一索引是 { owner, cardId }，同一个 cardId
 *    在库里是**每个装过的人各一份文档**，而各份的 name / summary / cover / modelUrl /
 *    genPrompt 完全可以不一样（自己改过名、装的是不同时期的版本）。广场按一种口径挑、
 *    安装按另一种口径挑，用户看到的和装进库的就是两张卡 —— 而且两次请求都 200，
 *    没有任何地方会报错。
 *
 *    两条路都以此为准：广场列表用 dedupeAuthoritative()，安装用 findAuthoritativeCard()，
 *    排序口径共用下面这个常量。
 */
const AUTHORITATIVE_SORT = { publishedAt: 1, _id: 1 };

/**
 * 已按 AUTHORITATIVE_SORT 排好的一批文档 → 每个 cardId 只留权威那份（即第一条）。
 * ⚠ 输入没排序的话这个函数是错的 —— 调用方必须带着 AUTHORITATIVE_SORT 查。
 */
function dedupeAuthoritative(sortedDocs) {
  const seen = new Set();
  const out = [];
  for (const doc of sortedDocs) {
    if (seen.has(doc.cardId)) continue;
    seen.add(doc.cardId);
    out.push(doc);
  }
  return out;
}

/** 单张卡的权威文档（安装走这条）。找不到 = 这张卡没人分享过 */
function findAuthoritativeCard(cardId) {
  return BranchCard.findOne({ cardId, published: true }).sort(AUTHORITATIVE_SORT).lean();
}

/** 分享出去的卡长什么样：私有字段（如设备本地的 modelUrl）在这里被剥掉 */
function toSharedCardPayload(doc, stats = EMPTY_STATS) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: doc.cardId,
    cardId: doc.cardId,
    type: doc.type,
    name: doc.name || "",
    summary: doc.summary || "",
    cover: doc.cover || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    modelUrl: shareableModelUrl(doc.modelUrl),
    genPrompt: doc.genPrompt || "",
    // 广场里就要能看到"这张卡挂了几张参考图"，否则装回来才发现是两张卡
    views: shareableViews(doc.views),
    description: doc.description || "",
    author: doc.owner && typeof doc.owner === "object" ? doc.owner : undefined,
    stats,
    publishedAt: doc.publishedAt,
  };
}

// POST /cards/:cardId/publish —— { description? }，仅卡主
async function publishCard(req, res, next) {
  try {
    const owner = req.user._id;
    const cardId = String(req.params.cardId || "").trim();
    if (!cardId) invalidId("Invalid card id");

    const doc = await BranchCard.findOne({ owner, cardId });
    if (!doc) notFound("Card not found");

    // ★ 版权闸门：第三方素材（BOOTH 购入的 rin / gratia / tsumire）**再配布需要授权**，
    //   这里直接 400 而不是"悄悄把 modelUrl 剥掉再发"——后者对用户是静默降级，
    //   对我们是"以为拦住了其实每次都在发"。自有的 milltina 不受此限。
    if (isThirdPartyModel(doc.modelUrl)) {
      badRequest("这张卡挂的是第三方版权模型，未获授权前不能分享");
    }

    if (req.body && req.body.description !== undefined) {
      doc.description = String(req.body.description || "").trim().slice(0, 200);
    }
    doc.published = true;
    doc.publishedAt = new Date();
    await doc.save();

    const stats = await loadStats("card", [cardId]);
    res.json({ ok: true, card: toCardPayload(doc.toObject(), stats.get(cardId) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// DELETE /cards/:cardId/publish —— 取消分享
async function unpublishCard(req, res, next) {
  try {
    const owner = req.user._id;
    const cardId = String(req.params.cardId || "").trim();
    if (!cardId) invalidId("Invalid card id");

    const doc = await BranchCard.findOne({ owner, cardId });
    if (!doc) notFound("Card not found");

    doc.published = false;
    doc.publishedAt = undefined;
    await doc.save();

    const stats = await loadStats("card", [cardId]);
    res.json({ ok: true, card: toCardPayload(doc.toObject(), stats.get(cardId) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// GET /cards/shared?q=&limit= —— 卡片广场（optionalAuth：不登录也能逛）
// Express 5 的 req.query 是只读 getter，validate({query}) 会静默失效，所以显式解析
async function listSharedCards(req, res, next) {
  try {
    const q = String(req.query.q || "").trim().slice(0, 60);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const filter = { published: true };
    if (q) {
      const rx = searchRegex(q);
      filter.$or = [{ name: rx }, { summary: rx }, { description: rx }, { tags: rx }];
    }

    // 分两步查，因为「广场上有哪些卡」和「每张卡该显示谁那份」是两件事：
    //  1) 先按最近发布捞一批候选，得到"广场上有哪些 cardId"（搜索条件也作用在这一步：
    //     任何一份副本的名字/标签命中，这张卡就该出现在广场里）；
    //  2) 再把这些 cardId 的**权威文档**查出来展示。
    // ★ 不能只做第一步再去重：那样留下的是"最近发布的那份"，而 installCard 装的是
    //   **最早发布的那份** —— 广场上看到的和装到手的会是不同的名字/封面/建模。
    const candidates = await BranchCard.find(filter)
      .sort({ publishedAt: -1 })
      .limit(limit * 4)
      .select("cardId")
      .lean();
    const cardIds = [...new Set(candidates.map((d) => d.cardId))].slice(0, limit);

    const rows = cardIds.length
      ? await BranchCard.find({ cardId: { $in: cardIds }, published: true })
          .sort(AUTHORITATIVE_SORT)
          .populate("owner", CARD_AUTHOR_FIELDS)
          .lean()
      : [];
    // 展示顺序仍然是「最近有人分享的排前面」，但每一行的**内容**来自权威那份
    const uniq = dedupeAuthoritative(rows).sort(
      (a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)
    );

    const stats = await loadStats("card", uniq.map((d) => d.cardId));

    // 已登录时标出「我库里已经有这张了」和「这是我自己发的」
    let ownedSet = new Set();
    if (req.user) {
      const mine = await BranchCard.find({ owner: req.user._id, cardId: { $in: cardIds } })
        .select("cardId")
        .lean();
      ownedSet = new Set(mine.map((c) => c.cardId));
    }

    res.json({
      ok: true,
      cards: uniq.map((d) => ({
        ...toSharedCardPayload(d, stats.get(d.cardId) || EMPTY_STATS),
        installed: ownedSet.has(d.cardId),
        isOwner: req.user ? String((d.owner && d.owner._id) || d.owner) === String(req.user._id) : false,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// POST /cards/:cardId/install —— 把别人分享的卡装进我的库。
// 幂等：{ owner, cardId } 唯一索引就是幂等的地基，重复装只会拿回已有那张。
async function installCard(req, res, next) {
  try {
    const owner = req.user._id;
    const cardId = String(req.params.cardId || "").trim();
    if (!cardId) invalidId("Invalid card id");

    const mine = await BranchCard.findOne({ owner, cardId }).lean();
    if (mine) {
      const stats = await loadStats("card", [cardId]);
      return res.json({
        ok: true,
        card: toCardPayload(mine, stats.get(cardId) || EMPTY_STATS),
        alreadyInstalled: true,
      });
    }

    // ★ 与广场列出的必须是**同一份文档**，口径见 findAuthoritativeCard 上面那段
    const src = await findAuthoritativeCard(cardId);
    if (!src) notFound("Card not found");

    await BranchCard.updateOne(
      { owner, cardId },
      {
        $setOnInsert: {
          owner,
          cardId,
          type: src.type,
          name: src.name,
          summary: src.summary,
          cover: src.cover,
          tags: src.tags,
          hot: src.hot,
          // ★ 设备本地指针与第三方素材都在这里被拦下：别人拿到的必须是他真能用的东西
          modelUrl: shareableModelUrl(src.modelUrl),
          genPrompt: src.genPrompt || "",
          views: shareableViews(src.views),
          createdAt: new Date(),
        },
      },
      { upsert: true }
    ).catch((e) => {
      // 并发装同一张：唯一索引撞车就是"已经有了"，幂等语义下不算失败
      if (!e || e.code !== 11000) throw e;
    });

    const saved = await BranchCard.findOne({ owner, cardId }).lean();
    const stats = await loadStats("card", [cardId]);
    res.status(201).json({ ok: true, card: toCardPayload(saved, stats.get(cardId) || EMPTY_STATS) });
  } catch (err) {
    next(err);
  }
}

// ── 互动：浏览 / 点赞 / 收藏 / 读计数 ──────────────────────────────

/** 路径参数 → { kind, key }。非法一律 400（这两个值会进 Mongo 查询与计数表主键） */
function parseAssetRef(req) {
  const kind = assetKindSchema.safeParse(String(req.params.kind || ""));
  const key = assetKeySchema.safeParse(String(req.params.key || ""));
  if (!kind.success) badRequest("Invalid asset kind");
  if (!key.success) badRequest("Invalid asset key");
  return { kind: kind.data, key: key.data };
}

/**
 * ★★ 会**写库**的互动端点必须先确认 key 真的指向一个存在的实体，再动手。
 *
 *   parseAssetRef 只管字符集，管不了"这个 key 有没有对应的东西"。而下面几处
 *   BranchAssetLike / BranchAssetStat / BranchAssetView 全是 `upsert: true` ——
 *   一个登录账号拿随机 key 打一轮，就能在三张带唯一索引的表里各造出一堆
 *   **谁也访问不到、任何 API 也删不掉**的行（没有实体，就没有"删掉它"的入口）。
 *   这不是刷热度，是往库里灌垃圾。
 *
 *   四条互动写端点（like/bookmark 的 POST|DELETE）与浏览端点共用这一个门（铁律六）。
 *   ⚠ 唯独 GET /stats 不走这道门：它**只读、不 upsert**，造不出任何行；
 *     而客户端手上常有本地才有的卡（还没同步上来的工坊卡），拿 0 回去比 404 更合用。
 */
async function assertAssetExists(kind, key) {
  if (kind === "deck") {
    // 卡组的 key 是 ObjectId 串；不合法就不必查库了（直接丢给 Mongo 会 CastError 变 500）
    const ok = mongoose.isValidObjectId(key) && (await BranchDeck.exists({ _id: key }));
    if (!ok) notFound("Deck not found");
    return;
  }
  // 卡片按 cardId 全局聚合（库里每个装过的人一份），有任意一份就算这张卡存在
  if (!(await BranchCard.exists({ cardId: key }))) notFound("Card not found");
}

/** 解析 + 存在性校验，写端点统一入口 */
async function resolveAssetRef(req) {
  const ref = parseAssetRef(req);
  await assertAssetExists(ref.kind, ref.key);
  return ref;
}

// ── 浏览去重 ──────────────────────────────────────────────────────

/** 匿名访客哈希的 pepper。JWT_SECRET 一定存在（生产自检会拒绝启动），且不外泄 */
const VIEW_HASH_PEPPER = () => process.env.VIEW_DEDUP_PEPPER || process.env.JWT_SECRET || "dev-view-pepper";

/** UTC 日期串。同一天同一访客只算一次，跨天重新开始 */
function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * 访客标识（BranchAssetView.viewer 的唯一生成处，字段语义见那个模型的文件头）。
 * ★ 匿名分支存的是 sha256(日期+pepper+IP) 的前 32 位，**不是 IP**：
 *   这张表只需要回答"今天数过没有"，存原始 IP 等于顺手建了一份"谁在什么时候看了什么"的档案。
 *   日期拌进哈希 → 每天换一次盐 → 跨天的行对不到同一个人身上。
 */
function viewerTag(req, day = utcDay()) {
  if (req.user?._id) return `u:${req.user._id}:${day}`;
  const digest = crypto
    .createHash("sha256")
    .update(`${day}:${VIEW_HASH_PEPPER()}:${clientIp(req)}`)
    .digest("hex")
    .slice(0, 32);
  return `a:${digest}`;
}

/** 今天第一次看这个实体吗？是 → true（该计数）；已经数过 → false */
async function markViewedToday(kind, key, req) {
  const now = new Date();
  const day = utcDay(now);
  // 过期时间给到"这一天结束后再多 1 小时"：viewer 里已经带了日期，行本身不会被复用，
  // TTL 只是把垃圾清掉。多留 1 小时纯粹是为了不和时区/时钟漂移较劲。
  const expiresAt = new Date(`${day}T00:00:00.000Z`);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 1);
  expiresAt.setUTCHours(expiresAt.getUTCHours() + 1);

  try {
    await BranchAssetView.create({ kind, key, viewer: viewerTag(req, day), expiresAt });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false; // 今天已经数过了
    throw e; // 其它错误照抛：静默当成"没数过"就等于去重没生效，而没人会发现
  }
}

/** 读一条计数（没有就当全 0），顺带带上"我赞过没有 / 我收藏过没有" */
async function readAssetStats(kind, key, userId) {
  const [row, liked, bookmarked] = await Promise.all([
    BranchAssetStat.findOne({ kind, key }).lean(),
    userId ? BranchAssetLike.exists({ user: userId, kind, key, action: "like" }) : Promise.resolve(null),
    userId ? BranchAssetLike.exists({ user: userId, kind, key, action: "bookmark" }) : Promise.resolve(null),
  ]);
  return { ...statsPayload(row), liked: !!liked, bookmarked: !!bookmarked };
}

// POST /assets/:kind/:key/view —— 浏览 +1（optionalAuth）
//
// ⚠ 这是本文件唯一一个**无鉴权的 $inc**。它需要三道门，缺一道就等于没有：
//   ① 路由上的 rateLimit —— 只减慢速度；
//   ② assertAssetExists —— 不让随手编的 key 造出无主计数行；
//   ③ markViewedToday —— 真正的去重：同一访客同一天对同一实体只计一次。
//   客户端那份 sessionStorage 去重是**装饰**，任何 HTTP 客户端都绕得过去，
//   服务端不自己数就是没数（app 仓 CLAUDE.md「互动计数一律要能防刷」同一条规矩）。
//
// 已经数过时**照常返回 200 + 最新计数**，不报错：对用户来说"再打开一次详情页"
// 本来就该是成功的，去重是我们内部的口径，不是他做错了什么。
async function addAssetView(req, res, next) {
  try {
    const { kind, key } = await resolveAssetRef(req);

    if (await markViewedToday(kind, key, req)) {
      try {
        await BranchAssetStat.updateOne({ kind, key }, { $inc: { views: 1 } }, { upsert: true });
      } catch (e) {
        // 首次浏览的并发 upsert 会撞唯一索引：那说明另一条请求已经建好了，重试一次即可
        if (!e || e.code !== 11000) throw e;
        await BranchAssetStat.updateOne({ kind, key }, { $inc: { views: 1 } });
      }
    }

    res.json({ ok: true, stats: await readAssetStats(kind, key, req.user?._id) });
  } catch (err) {
    next(err);
  }
}

/**
 * 点赞 / 收藏的唯一实现（四条路由共用：POST|DELETE × like|bookmark）。
 * ★ 计数不 $inc，而是从去重表 countDocuments 重算后 $set —— 重复点、并发、
 *   点了又取消这三种情况下 $inc 都会漂移，而漂移出来的数字没法校回去。
 */
async function setAssetAction(req, res, next, action, on) {
  try {
    // ★ 必须过存在性这道门：下面两处都是 upsert，key 编一个就能造出无主的行
    const { kind, key } = await resolveAssetRef(req);
    const user = req.user._id;

    if (on) {
      try {
        await BranchAssetLike.updateOne(
          { user, kind, key, action },
          { $setOnInsert: { user, kind, key, action } },
          { upsert: true }
        );
      } catch (e) {
        if (!e || e.code !== 11000) throw e; // 已经有了 = 这次点赞是幂等的重复
      }
    } else {
      await BranchAssetLike.deleteOne({ user, kind, key, action });
    }

    const [likes, bookmarks] = await Promise.all([
      BranchAssetLike.countDocuments({ kind, key, action: "like" }),
      BranchAssetLike.countDocuments({ kind, key, action: "bookmark" }),
    ]);
    try {
      await BranchAssetStat.updateOne({ kind, key }, { $set: { likes, bookmarks } }, { upsert: true });
    } catch (e) {
      if (!e || e.code !== 11000) throw e;
      await BranchAssetStat.updateOne({ kind, key }, { $set: { likes, bookmarks } });
    }

    res.json({ ok: true, stats: await readAssetStats(kind, key, user) });
  } catch (err) {
    next(err);
  }
}

const likeAsset = (req, res, next) => setAssetAction(req, res, next, "like", true);
const unlikeAsset = (req, res, next) => setAssetAction(req, res, next, "like", false);
const bookmarkAsset = (req, res, next) => setAssetAction(req, res, next, "bookmark", true);
const unbookmarkAsset = (req, res, next) => setAssetAction(req, res, next, "bookmark", false);

// GET /assets/:kind/:key/stats（optionalAuth）
async function getAssetStats(req, res, next) {
  try {
    const { kind, key } = parseAssetRef(req);
    res.json({ ok: true, stats: await readAssetStats(kind, key, req.user?._id) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listCards,
  addCards,
  updateCard,
  removeCard,
  // ★ 导出给 branchVideo.controller：随作品发布的卡组快照也要带 views，
  //   而"哪几张能存/能发出去"这条规则只能有一处实现（铁律六）
  shareableViews,
  listDecks,
  createDeck,
  updateDeck,
  deleteDeck,
  publishDeck,
  unpublishDeck,
  listSharedDecks,
  installDeck,
  publishCard,
  unpublishCard,
  listSharedCards,
  installCard,
  addAssetView,
  likeAsset,
  unlikeAsset,
  bookmarkAsset,
  unbookmarkAsset,
  getAssetStats,
};
