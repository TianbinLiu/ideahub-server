// src/controllers/live2dModel.controller.js
// Live2D 模型市场：列表 / 详情 / 上传（zip + 人格 + 音频三板块）/ 改 / 删 / 收藏下载 / 点赞。
// 形状与人格市场（persona.controller.js）对齐，前端两个市场页可以照抄同一套交互。
const mongoose = require("mongoose");
const Live2dModel = require("../models/Live2dModel");
const Live2dModelInstall = require("../models/Live2dModelInstall");
const Live2dModelLike = require("../models/Live2dModelLike");
const CompanionSetting = require("../models/CompanionSetting");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");
const bundle = require("../services/live2dBundle.service");
const market = require("../services/live2dMarket.service");
const { checkPersonaAccess } = require("../services/personaAccess.service");
// 「音频」板块的写入口：完整 VoiceSettings 或 { templateId }（从声音市场的模板展开成快照）
const { expandVoiceInput } = require("../services/voiceTemplate.service");
const { listQuery } = require("../schemas/live2dModel.schemas");

const MAX_TAGS = 10;

function isValidId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}

function toTags(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s，、]+/) : [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const tag = String(t || "").trim().slice(0, 30);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 封面只收 http(s) URL（与人格封面同一条规则）；别的（javascript: / data:）一律当没填 */
function normalizeSafeUrl(input) {
  const value = String(input || "").trim().slice(0, 2000);
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) ? value : "";
  } catch {
    return "";
  }
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 绑定人格前先过可用性判定；不可用就整句拒绝（作者应该知道自己绑了个别人用不了的东西） */
async function resolvePersonaBinding(personaId, user) {
  const id = String(personaId || "").trim();
  if (!id) return null;
  const { persona, reason } = await checkPersonaAccess(id, user._id);
  if (!persona) {
    throw new AppError({
      code: reason === "not_found" ? CODES.NOT_FOUND : CODES.FORBIDDEN,
      status: reason === "not_found" ? 404 : 403,
      message: reason === "unpaid" ? "Buy the persona before binding it" : reason === "private" ? "That persona is private" : "Persona not found",
      details: { reason },
    });
  }
  return persona._id;
}

async function loadUserContext(user, docs) {
  if (!user || !docs.length) return { installed: new Set(), liked: new Set() };
  const ids = docs.map((d) => d._id);
  const [installs, likes] = await Promise.all([
    Live2dModelInstall.find({ user: user._id, model: { $in: ids } }).select("model").lean(),
    Live2dModelLike.find({ user: user._id, model: { $in: ids } }).select("model").lean(),
  ]);
  return {
    installed: new Set(installs.map((x) => String(x.model))),
    liked: new Set(likes.map((x) => String(x.model))),
  };
}

function payloadWith(doc, req, user, ctx) {
  const id = String(doc._id);
  return market.toLive2dModelPayload(doc, req, {
    viewerId: user ? user._id : "",
    installed: ctx.installed.has(id),
    liked: ctx.liked.has(id),
  });
}

async function listModels(req, res, next) {
  try {
    // Express 5 的 req.query 只读，不能靠 validate 中间件回写；ZodError 交给统一错误处理 → 400
    const { page, limit, sort, q, tag, scope } = listQuery.parse(req.query);
    const user = req.user || null;
    if ((scope === "installed" || scope === "mine") && !user) {
      return res.status(401).json({ ok: false, message: "Login required", code: CODES.UNAUTHORIZED });
    }

    const filter = {};
    if (scope === "mine") {
      filter.author = user._id;
    } else if (scope === "installed") {
      const rows = await Live2dModelInstall.find({ user: user._id }).select("model").lean();
      filter._id = { $in: rows.map((r) => r.model) };
      // 收藏过但作者已取消分享的：作者本人还能看到，别人看不到（死链过滤，与人格同款）
      filter.$or = [{ shared: true }, { author: user._id }];
    } else {
      filter.shared = true;
    }
    if (q) {
      const re = new RegExp(escapeRegex(q), "i");
      const textOr = [{ name: re }, { description: re }, { tags: re }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: textOr }];
        delete filter.$or;
      } else {
        filter.$or = textOr;
      }
    }
    if (tag) filter.tags = tag;

    const sortSpec = sort === "hot" ? { "stats.downloadCount": -1, "stats.likeCount": -1, createdAt: -1 } : { createdAt: -1 };
    const [total, docs] = await Promise.all([
      Live2dModel.countDocuments(filter),
      Live2dModel.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("author", "_id username")
        .populate("persona")
        .lean(),
    ]);
    const ctx = await loadUserContext(user, docs);
    const models = docs.map((d) => payloadWith(d, req, user, ctx));
    // 官方内置的看板娘排在广场第一页最前面（不计入 total）：换回默认也要能在市场里点到
    if (scope === "all" && page === 1 && !q && !tag) models.unshift(market.officialModelPayload());
    res.json({ ok: true, models, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    next(err);
  }
}

async function getModel(req, res, next) {
  try {
    const { id } = req.params;
    if (market.isOfficialId(id)) return res.json({ ok: true, model: market.officialModelPayload() });
    if (!isValidId(id)) invalidId("Invalid model id");
    const doc = await Live2dModel.findById(id).populate("author", "_id username").populate("persona").lean();
    if (!doc) notFound("Live2D model not found");
    const user = req.user || null;
    const isOwner = !!user && market.authorIdOf(doc) === String(user._id);
    if (!doc.shared && !isOwner) forbidden("This model is private");
    await Live2dModel.updateOne({ _id: doc._id }, { $inc: { "stats.viewCount": 1 } });
    doc.stats = { ...(doc.stats || {}), viewCount: Number(doc?.stats?.viewCount || 0) + 1 };
    const ctx = await loadUserContext(user, [doc]);
    res.json({ ok: true, model: payloadWith(doc, req, user, ctx) });
  } catch (err) {
    next(err);
  }
}

async function createModel(req, res, next) {
  let installed = null;
  try {
    if (!req.file) badRequest("Upload the Live2D bundle (.zip) as the `bundle` field");
    const body = req.body;
    const personaId = await resolvePersonaBinding(body.personaId, req.user);
    // 嗓子也在解压之前定下来：模板不存在 / 私有会 404 / 403，别白解一个包
    const voice = await expandVoiceInput(body.voice, req.user._id);
    installed = await bundle.installBundle(req.file.buffer, {
      rootRelativeDir: `live2d-market/${String(req.user._id)}`,
      originalName: req.file.originalname,
    });
    const doc = await Live2dModel.create({
      author: req.user._id,
      name: body.name,
      description: body.description || "",
      coverImageUrl: normalizeSafeUrl(body.coverImageUrl),
      tags: toTags(body.tags),
      bundleDir: installed.bundleDir,
      modelJsonPath: installed.modelJsonPath,
      bundleName: String(req.file.originalname || "").slice(0, 200),
      bundleBytes: installed.bytes,
      fileCount: installed.files,
      persona: personaId,
      voice,
      shared: Boolean(body.shared),
    });
    const populated = await Live2dModel.findById(doc._id).populate("author", "_id username").populate("persona").lean();
    res.status(201).json({ ok: true, model: market.toLive2dModelPayload(populated, req, { viewerId: req.user._id }) });
  } catch (err) {
    if (installed) await bundle.removeBundleDir(installed.bundleDir);
    next(err);
  }
}

async function updateModel(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid model id");
    const doc = await Live2dModel.findById(id);
    if (!doc) notFound("Live2D model not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    const body = req.body;
    if (body.name !== undefined) doc.name = body.name;
    if (body.description !== undefined) doc.description = body.description;
    if (body.coverImageUrl !== undefined) doc.coverImageUrl = normalizeSafeUrl(body.coverImageUrl);
    if (body.tags !== undefined) doc.tags = toTags(body.tags);
    if (body.shared !== undefined) doc.shared = Boolean(body.shared);
    if (body.personaId !== undefined) doc.persona = body.personaId === null ? null : await resolvePersonaBinding(body.personaId, req.user);
    if (body.voice !== undefined) doc.voice = body.voice === null ? null : await expandVoiceInput(body.voice, req.user._id);
    await doc.save();

    const populated = await Live2dModel.findById(doc._id).populate("author", "_id username").populate("persona").lean();
    const ctx = await loadUserContext(req.user, [populated]);
    res.json({ ok: true, model: payloadWith(populated, req, req.user, ctx) });
  } catch (err) {
    next(err);
  }
}

async function removeModel(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid model id");
    const doc = await Live2dModel.findById(id);
    if (!doc) notFound("Live2D model not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      Live2dModel.deleteOne({ _id: doc._id }),
      Live2dModelInstall.deleteMany({ model: doc._id }),
      Live2dModelLike.deleteMany({ model: doc._id }),
      // 正在用它的用户静默回到官方看板娘
      CompanionSetting.updateMany({ model: doc._id }, { $set: { model: null } }),
    ]);
    // 文件最后删：库记录没了之后就算目录删失败也只是磁盘垃圾，不会出现"有记录没文件"的死链
    await bundle.removeBundleDir(doc.bundleDir);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function loadInstallable(id) {
  if (market.isOfficialId(id)) badRequest("The official model is built in and needs no install");
  if (!isValidId(id)) invalidId("Invalid model id");
  const doc = await Live2dModel.findById(id).select("_id author shared stats").lean();
  if (!doc) notFound("Live2D model not found");
  return doc;
}

async function installModel(req, res, next) {
  try {
    const doc = await loadInstallable(req.params.id);
    if (!doc.shared && String(doc.author) !== String(req.user._id)) forbidden("This model is private");
    let created = false;
    try {
      await Live2dModelInstall.create({ user: req.user._id, model: doc._id });
      created = true;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e;
    }
    let downloadCount = Number(doc?.stats?.downloadCount || 0);
    if (created) {
      const updated = await Live2dModel.findByIdAndUpdate(doc._id, { $inc: { "stats.downloadCount": 1 } }, { new: true }).select("stats").lean();
      downloadCount = Number(updated?.stats?.downloadCount || downloadCount + 1);
    }
    res.json({ ok: true, installed: true, downloadCount });
  } catch (err) {
    next(err);
  }
}

async function uninstallModel(req, res, next) {
  try {
    const doc = await loadInstallable(req.params.id);
    const removed = await Live2dModelInstall.deleteOne({ user: req.user._id, model: doc._id });
    let downloadCount = Number(doc?.stats?.downloadCount || 0);
    if (removed.deletedCount) {
      const updated = await Live2dModel.findByIdAndUpdate(doc._id, { $inc: { "stats.downloadCount": -1 } }, { new: true }).select("stats").lean();
      downloadCount = Math.max(0, Number(updated?.stats?.downloadCount || 0));
    }
    res.json({ ok: true, installed: false, downloadCount });
  } catch (err) {
    next(err);
  }
}

async function toggleLike(req, res, next) {
  try {
    const doc = await loadInstallable(req.params.id);
    if (!doc.shared && String(doc.author) !== String(req.user._id)) forbidden("This model is private");
    const existing = await Live2dModelLike.findOne({ user: req.user._id, model: doc._id }).lean();
    let liked;
    if (existing) {
      await Live2dModelLike.deleteOne({ _id: existing._id });
      liked = false;
    } else {
      try {
        await Live2dModelLike.create({ user: req.user._id, model: doc._id });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;
      }
      liked = true;
    }
    const likeCount = await Live2dModelLike.countDocuments({ model: doc._id });
    await Live2dModel.updateOne({ _id: doc._id }, { $set: { "stats.likeCount": likeCount } });
    res.json({ ok: true, liked, likeCount });
  } catch (err) {
    next(err);
  }
}

module.exports = { listModels, getModel, createModel, updateModel, removeModel, installModel, uninstallModel, toggleLike, toTags };
