// src/controllers/speakingStyle.controller.js
// 发言风格面板控制器：取当前用户档案 / 聚合发言并生成档案 / 公开查看某用户档案。
const mongoose = require("mongoose");
const SpeakingProfile = require("../models/SpeakingProfile");
const ScenarioMessage = require("../models/ScenarioMessage");
const BountySubmission = require("../models/BountySubmission");
const Comment = require("../models/Comment");
const { generateStyleProfile } = require("../services/speakingStyleAi.service");
const { invalidId } = require("../utils/http");

// 每个来源最近取多少条 / 每条截断长度 / 合并后的总条数上限
const PER_SOURCE_LIMIT = 30;
const TEXT_MAX_LEN = 300;
const TOTAL_CAP = 60;

function isValidId(id) {
  return mongoose.isValidObjectId(id);
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
    standName: doc.standName || "",
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
  const [scenarioMsgs, submissions, comments] = await Promise.all([
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

  const raw = [
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
      standName: result.standName || "",
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

module.exports = { getMine, generate, getByUser };
