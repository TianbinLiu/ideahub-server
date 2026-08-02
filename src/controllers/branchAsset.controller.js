// src/controllers/branchAsset.controller.js
// 分支视频 · 卡片与卡组控制器。
// 卡片：我的列表 / 批量新增（按 { owner, cardId } 幂等，已存在直接跳过）/ 删除（同时从所有卡组里摘除）。
// 卡组：我的列表 / 建组 / 改名改卡 / 删组，全部做归属校验。
// 卡面 cover 可能是 Seedream 出图的 dataURL，入库前转存 Cloudinary 拿永久 URL；
// 单张转存失败降级保留原值并 warn，不阻断整批。
const mongoose = require("mongoose");
const BranchCard = require("../models/BranchCard");
const BranchDeck = require("../models/BranchDeck");
const { uploadToCloudinary } = require("../middleware/upload");
const { forbidden, notFound, invalidId } = require("../utils/http");

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

// ── 序列化 ────────────────────────────────────────────────────────
// 客户端 Card 形状是 { id, type, name, summary, cover, hot?, tags? }，
// 这里同时给出 id 与 cardId，前端两种写法都能直接吃。
function toCardPayload(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: doc.cardId,
    cardId: doc.cardId,
    type: doc.type,
    name: doc.name || "",
    summary: doc.summary || "",
    cover: doc.cover || "",
    hot: Number(doc.hot || 0),
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    createdAt: doc.createdAt,
  };
}

function toDeckPayload(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    id: String(doc._id),
    name: doc.name || "",
    cardIds: Array.isArray(doc.cardIds) ? doc.cardIds : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
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
    res.json({ ok: true, cards: docs.map(toCardPayload) });
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

    res.status(201).json({
      ok: true,
      cards: saved.map(toCardPayload),
      added: upsertedCount,
      skipped: skippedIds.length,
      skippedIds,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /cards/:cardId —— 删卡，并从该用户所有卡组里摘掉
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
    res.json({ ok: true, decks: docs.map(toDeckPayload) });
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

// PATCH /decks/:id —— { name?, cardIds? }
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

    await doc.save();
    res.json({ ok: true, deck: toDeckPayload(doc.toObject()) });
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

module.exports = {
  listCards,
  addCards,
  removeCard,
  listDecks,
  createDeck,
  updateDeck,
  deleteDeck,
};
