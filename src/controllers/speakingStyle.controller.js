// src/controllers/speakingStyle.controller.js
// 发言风格面板控制器：取当前用户档案 / 聚合发言并生成档案 / 公开查看某用户档案。
// 另含「风格记忆」样本管理（用户自己粘贴或用插件就地收集的发言）：增 / 查 / 删 / 清空。
const crypto = require("crypto");
const mongoose = require("mongoose");
const SpeakingProfile = require("../models/SpeakingProfile");
const StyleSample = require("../models/StyleSample");
const ScenarioMessage = require("../models/ScenarioMessage");
const BountySubmission = require("../models/BountySubmission");
const Comment = require("../models/Comment");
const { generateStyleProfile } = require("../services/speakingStyleAi.service");
const { invalidId, notFound } = require("../utils/http");

// 每个来源最近取多少条 / 每条截断长度 / 合并后的总条数上限
const PER_SOURCE_LIMIT = 30;
const TEXT_MAX_LEN = 300;
const TOTAL_CAP = 80;
// 生成档案时最多参考多少条「用户自己的样本」（排在合并数组最前面）
const OWN_SAMPLE_LIMIT = 40;
// 单条样本入库前的截断长度（与 StyleSample.text maxlength / samplesBody 一致）
const SAMPLE_MAX_LEN = 1000;

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

// ── 风格记忆样本工具 ───────────────────────────────────────────────
// 规范化：去首尾空白 + 折叠内部连续空白，让「同一句话的不同排版」判为同一条
function normalize(t) {
  return String(t || "").trim().replace(/\s+/g, " ");
}

function hashText(t) {
  return crypto.createHash("sha1").update(normalize(t)).digest("hex");
}

// 先规范化再截断；截断可能在末尾留下空格，故再 trim 一次，
// 保证入库的 text 与用来算 hash 的字符串完全一致（否则去重会漏）
function prepareSampleText(t) {
  return normalize(t).slice(0, SAMPLE_MAX_LEN).trim();
}

// ── 序列化（严格对齐冻结契约 SpeakingProfile）───────────────────────
function serializeStat(s) {
  return {
    key: s.key || "",
    label: s.label || "",
    value: Number(s.value || 0),
    grade: s.grade || "E",
  };
}

function serializeProfile(doc, { includeTally = true } = {}) {
  if (!doc) return null;
  const out = {
    summary: doc.summary || "",
    catchphrases: Array.isArray(doc.catchphrases) ? doc.catchphrases : [],
    stats: Array.isArray(doc.stats) ? doc.stats.map(serializeStat) : [],
    sampleCount: Number(doc.sampleCount || 0),
    generatedAt: doc.generatedAt || doc.updatedAt || new Date(),
    user: doc.user,
  };
  // styleTally 是本人的行为数据，仅在本人查看时返回；公开查看不泄露
  if (includeTally) out.styleTally = doc.styleTally && typeof doc.styleTally === "object" ? doc.styleTally : {};
  if (doc.model) out.model = doc.model;
  if (typeof doc.heuristic === "boolean") out.heuristic = doc.heuristic;
  return out;
}

// 4c：只保留已知风格键的正整数次数，防止任意数据写入
const STYLE_KEYS = ["rational", "troll", "deflect", "mock", "deescalate", "support"];
function normalizeStyleTally(tally) {
  const out = {};
  if (tally && typeof tally === "object") {
    for (const k of STYLE_KEYS) {
      const n = Math.floor(Number(tally[k]));
      if (Number.isFinite(n) && n > 0) out[k] = Math.min(n, 100000);
    }
  }
  return out;
}

// ── 聚合当前用户的发言文本 ─────────────────────────────────────────
async function collectTexts(userId) {
  const [ownSamples, scenarioMsgs, submissions, comments] = await Promise.all([
    StyleSample.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(OWN_SAMPLE_LIMIT)
      .select("text")
      .lean(),
    ScenarioMessage.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(PER_SOURCE_LIMIT)
      .select("text")
      .lean(),
    BountySubmission.find({ hunter: userId })
      .sort({ createdAt: -1 })
      .limit(PER_SOURCE_LIMIT)
      .select("speechText")
      .lean(),
    Comment.find({ author: userId })
      .sort({ createdAt: -1 })
      .limit(PER_SOURCE_LIMIT)
      .select("content")
      .lean(),
  ]);

  // 用户自己提供的样本排在【最前面】：它们最能代表本人真实口吻，
  // 因此在 TOTAL_CAP 截断时优先保留。
  const raw = [
    ...ownSamples.map((s) => s.text),
    ...scenarioMsgs.map((m) => m.text),
    ...submissions.map((s) => s.speechText),
    ...comments.map((c) => c.content),
  ];

  return raw
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .map((t) => t.slice(0, TEXT_MAX_LEN))
    .slice(0, TOTAL_CAP);
}

// ── 控制器 ────────────────────────────────────────────────────────

// GET /api/speaking-style —— 当前用户的档案（未生成过则 null）
async function getMine(req, res, next) {
  try {
    const doc = await SpeakingProfile.findOne({ user: req.user._id }).lean();
    res.json({ ok: true, profile: serializeProfile(doc) });
  } catch (err) {
    next(err);
  }
}

// POST /api/speaking-style/generate —— 聚合文本 → service 生成 → upsert 保存
async function generate(req, res, next) {
  try {
    const userId = req.user._id;
    const styleTally = normalizeStyleTally(req.body && req.body.styleTally);

    const texts = await collectTexts(userId);
    const result = await generateStyleProfile({ texts, styleTally });

    const update = {
      user: userId,
      summary: result.summary || "",
      catchphrases: Array.isArray(result.catchphrases) ? result.catchphrases : [],
      stats: Array.isArray(result.stats) ? result.stats : [],
      sampleCount: texts.length,
      styleTally,
      model: result.model || "",
      heuristic: !!result.heuristic,
      generatedAt: new Date(),
    };

    const doc = await SpeakingProfile.findOneAndUpdate({ user: userId }, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }).lean();

    res.json({ ok: true, profile: serializeProfile(doc), sampleCount: texts.length });
  } catch (err) {
    next(err);
  }
}

// GET /api/speaking-style/user/:userId —— 公开查看某用户档案（未生成过则 null）
async function getByUser(req, res, next) {
  try {
    const { userId } = req.params;
    if (!isValidId(userId)) invalidId("Invalid user id");
    const doc = await SpeakingProfile.findOne({ user: userId }).lean();
    // 公开查看：不返回本人行为数据 styleTally
    res.json({ ok: true, profile: serializeProfile(doc, { includeTally: false }) });
  } catch (err) {
    next(err);
  }
}

// ── 风格记忆样本 ──────────────────────────────────────────────────

function serializeSample(doc) {
  return {
    _id: doc._id,
    text: doc.text || "",
    source: doc.source || "paste",
    platform: doc.platform || "",
    createdAt: doc.createdAt,
  };
}

function errCode(e) {
  if (!e) return undefined;
  return e.code != null ? e.code : e.err && e.err.code;
}

function extractWriteErrors(err) {
  if (!err) return [];
  if (Array.isArray(err.writeErrors)) return err.writeErrors;
  if (err.writeErrors) return [err.writeErrors]; // 只有 1 条错误时驱动可能不给数组
  return [];
}

// 只有「全部失败都是重复键」才算可容忍；混进别的写错误照常抛出
function isDuplicateOnlyError(err) {
  if (!err) return false;
  const writeErrors = extractWriteErrors(err);
  if (writeErrors.length) return writeErrors.every((e) => errCode(e) === 11000);
  return err.code === 11000;
}

// insertMany(ordered:false)：遇到已存在的样本会抛 E11000 / BulkWriteError，
// 但其余样本仍会插入成功 —— 重复只算 skipped，不算整批失败。
async function insertSamplesIgnoringDuplicates(docs) {
  try {
    const inserted = await StyleSample.insertMany(docs, { ordered: false });
    return Array.isArray(inserted) ? inserted.length : 0;
  } catch (err) {
    if (!isDuplicateOnlyError(err)) throw err;
    // ordered:false 时 mongoose 把真正插入成功的文档挂在 err.insertedDocs 上
    if (Array.isArray(err.insertedDocs)) return err.insertedDocs.length;
    // 兜底：至少有 1 条因重复失败
    const failed = Math.max(extractWriteErrors(err).length, 1);
    return Math.max(docs.length - failed, 0);
  }
}

// POST /api/speaking-style/samples —— 把用户自己的发言收进风格记忆（粘贴 / 插件就地收集）
async function addSamples(req, res, next) {
  try {
    const userId = req.user._id;
    const { texts, source, platform } = req.body;

    // 同一批 texts 内部可能自带重复：先按 hash 批内自去重
    // （否则 ordered:false 会把「批内重复」也报成写错误，added 统计失真）
    const seen = new Set();
    const docs = [];
    for (const t of texts) {
      const text = prepareSampleText(t);
      if (!text) continue;
      const hash = hashText(text);
      if (seen.has(hash)) continue;
      seen.add(hash);
      docs.push({
        user: userId,
        text,
        hash,
        source: source || "paste",
        platform: platform || "",
      });
    }

    const added = docs.length ? await insertSamplesIgnoringDuplicates(docs) : 0;
    const total = await StyleSample.countDocuments({ user: userId });

    // skipped 同时涵盖：批内重复、与历史样本重复、规范化后为空
    res.json({ ok: true, added, skipped: texts.length - added, total });
  } catch (err) {
    next(err);
  }
}

// GET /api/speaking-style/samples —— 分页查看自己的样本
async function listSamples(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);

    const filter = { user: req.user._id };
    const total = await StyleSample.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const items = await StyleSample.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      ok: true,
      samples: items.map(serializeSample),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/speaking-style/samples/:id —— 删除自己的一条样本
async function deleteSample(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid sample id");
    // 带 user 条件：只能删自己的
    const doc = await StyleSample.findOneAndDelete({ _id: id, user: req.user._id }).lean();
    if (!doc) notFound("Sample not found");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/speaking-style/samples —— 清空自己的全部样本
async function clearSamples(req, res, next) {
  try {
    const result = await StyleSample.deleteMany({ user: req.user._id });
    res.json({ ok: true, deleted: (result && result.deletedCount) || 0 });
  } catch (err) {
    next(err);
  }
}

module.exports = { getMine, generate, getByUser, addSamples, listSamples, deleteSample, clearSamples };
