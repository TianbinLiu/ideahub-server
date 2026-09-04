// src/controllers/voiceTemplate.controller.js
// 声音市场（混音模板）：列表 / 详情 / 创建 / 改 / 删 / 点赞 / 使用计数。
// 形状与 Live2D 模型市场（live2dModel.controller.js）对齐，前端市场页照抄同一套交互。
// 没有 install（收藏）与 viewCount：模板是「听一下、用不用」的东西，计的是 useCount。
const mongoose = require("mongoose");
const VoiceTemplate = require("../models/VoiceTemplate");
const VoiceTemplateLike = require("../models/VoiceTemplateLike");
const CODES = require("../utils/errorCodes");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const { normalizeMix } = require("../utils/voiceSettings");
const svc = require("../services/voiceTemplate.service");
const { listQuery } = require("../schemas/voiceTemplate.schemas");

function isValidId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadUserContext(user, docs) {
  if (!user || !docs.length) return { liked: new Set() };
  const likes = await VoiceTemplateLike.find({ user: user._id, template: { $in: docs.map((d) => d._id) } })
    .select("template")
    .lean();
  return { liked: new Set(likes.map((x) => String(x.template))) };
}

function payloadWith(doc, user, ctx) {
  return svc.toVoiceTemplatePayload(doc, { viewerId: user ? user._id : "", liked: ctx.liked.has(String(doc._id)) });
}

/** zod 已保证 1～3 味且都在 1.0 目录里；这里归一权重（和 = 1、三位小数、同音色合并） */
function recipeOf(raw) {
  const recipe = normalizeMix(raw);
  if (!recipe) badRequest("recipe needs at least one mixable 1.0 voice");
  return recipe;
}

async function listTemplates(req, res, next) {
  try {
    // Express 5 的 req.query 只读，不能靠 validate 中间件回写；ZodError 交给统一错误处理 → 400
    const { page, limit, sort, q, scope } = listQuery.parse(req.query);
    const user = req.user || null;
    if (scope === "mine" && !user) {
      return res.status(401).json({ ok: false, message: "Login required", code: CODES.UNAUTHORIZED });
    }
    const filter = scope === "mine" ? { author: user._id } : { shared: true };
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ name: re }, { description: re }];
    }
    const sortSpec = sort === "hot" ? { "stats.useCount": -1, "stats.likeCount": -1, createdAt: -1 } : { createdAt: -1 };
    const [total, docs] = await Promise.all([
      VoiceTemplate.countDocuments(filter),
      VoiceTemplate.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username")
        .lean(),
    ]);
    const ctx = await loadUserContext(user, docs);
    res.json({
      ok: true,
      templates: docs.map((d) => payloadWith(d, user, ctx)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

async function getTemplate(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid voice template id");
    const doc = await VoiceTemplate.findById(id).populate("author", "_id username").lean();
    if (!doc) notFound("Voice template not found");
    const user = req.user || null;
    const isOwner = !!user && svc.authorIdOf(doc) === String(user._id);
    if (!doc.shared && !isOwner) forbidden("This voice template is private");
    const ctx = await loadUserContext(user, [doc]);
    res.json({ ok: true, template: payloadWith(doc, user, ctx) });
  } catch (err) {
    next(err);
  }
}

async function createTemplate(req, res, next) {
  try {
    const body = req.body;
    const doc = await VoiceTemplate.create({
      author: req.user._id,
      name: body.name,
      description: body.description || "",
      recipe: recipeOf(body.recipe),
      rate: typeof body.rate === "number" ? body.rate : null,
      pitch: typeof body.pitch === "number" ? body.pitch : null,
      instruct: body.instruct || "",
      expressive: body.expressive !== false,
      shared: Boolean(body.shared),
    });
    const populated = await VoiceTemplate.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, template: svc.toVoiceTemplatePayload(populated, { viewerId: req.user._id }) });
  } catch (err) {
    next(err);
  }
}

async function updateTemplate(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid voice template id");
    const doc = await VoiceTemplate.findById(id);
    if (!doc) notFound("Voice template not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    // 改配方不会波及已经「使用」它的人：他们手里是快照（见 models/VoiceTemplate.js）
    const body = req.body;
    if (body.name !== undefined) doc.name = body.name;
    if (body.description !== undefined) doc.description = body.description;
    if (body.recipe !== undefined) doc.recipe = recipeOf(body.recipe);
    if (body.rate !== undefined) doc.rate = body.rate;
    if (body.pitch !== undefined) doc.pitch = body.pitch;
    if (body.instruct !== undefined) doc.instruct = body.instruct;
    if (body.expressive !== undefined) doc.expressive = Boolean(body.expressive);
    if (body.shared !== undefined) doc.shared = Boolean(body.shared);
    await doc.save();

    const populated = await VoiceTemplate.findById(doc._id).populate("author", "_id username").lean();
    const ctx = await loadUserContext(req.user, [populated]);
    res.json({ ok: true, template: payloadWith(populated, req.user, ctx) });
  } catch (err) {
    next(err);
  }
}

async function removeTemplate(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid voice template id");
    const doc = await VoiceTemplate.findById(id).select("_id author").lean();
    if (!doc) notFound("Voice template not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      VoiceTemplate.deleteOne({ _id: doc._id }),
      VoiceTemplateLike.deleteMany({ template: doc._id }),
      // 正在用它的人保留配方快照、只摘掉「使用中」标记
      svc.detachTemplateEverywhere(doc._id),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** like / use 共用：模板要存在且（公开或自己的） */
async function loadActionable(id, user) {
  if (!isValidId(id)) invalidId("Invalid voice template id");
  const doc = await VoiceTemplate.findById(id).select("_id author shared stats").lean();
  if (!doc) notFound("Voice template not found");
  if (!doc.shared && String(doc.author) !== String(user._id)) forbidden("This voice template is private");
  return doc;
}

async function toggleLike(req, res, next) {
  try {
    const doc = await loadActionable(req.params.id, req.user);
    const existing = await VoiceTemplateLike.findOne({ user: req.user._id, template: doc._id }).lean();
    let liked;
    if (existing) {
      await VoiceTemplateLike.deleteOne({ _id: existing._id });
      liked = false;
    } else {
      try {
        await VoiceTemplateLike.create({ user: req.user._id, template: doc._id });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // 并发重复请求：已点赞，幂等
      }
      liked = true;
    }
    const likeCount = await VoiceTemplateLike.countDocuments({ template: doc._id });
    await VoiceTemplate.updateOne({ _id: doc._id }, { $set: { "stats.likeCount": likeCount } });
    res.json({ ok: true, liked, likeCount });
  } catch (err) {
    next(err);
  }
}

/** POST /:id/use —— 前端把模板应用到数字人 / 人格 / 模型时调一次，纯计数（不要求幂等） */
async function useTemplate(req, res, next) {
  try {
    const doc = await loadActionable(req.params.id, req.user);
    const updated = await VoiceTemplate.findByIdAndUpdate(doc._id, { $inc: { "stats.useCount": 1 } }, { returnDocument: "after" })
      .select("stats")
      .lean();
    res.json({ ok: true, useCount: Number(updated?.stats?.useCount || 0) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listTemplates, getTemplate, createTemplate, updateTemplate, removeTemplate, toggleLike, useTemplate };
