// src/controllers/persona.controller.js
// 人格下载（Persona）控制器：广场/收藏/发布列表、详情（$inc view）、增删改（owner 校验）、
// 收藏下载（install/uninstall）、点赞（toggle）、装备（equip/equipped）。
const mongoose = require("mongoose");
const Persona = require("../models/Persona");
const PersonaInstall = require("../models/PersonaInstall");
const PersonaLike = require("../models/PersonaLike");
const PersonaEquip = require("../models/PersonaEquip");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function clampNum(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeEmoji(raw) {
  const v = String(raw || "").trim().slice(0, 8);
  return v || "🎭";
}

function toTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  }
  return [...new Set(
    String(raw || "")
      .split(/[#,，,\s|]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 12);
}

function normalizeStyle(raw) {
  const style = raw && typeof raw === "object" ? raw : {};
  return {
    summary: String(style.summary || "").trim().slice(0, 2000),
    catchphrases: Array.isArray(style.catchphrases)
      ? style.catchphrases.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 50)
      : [],
    stats: Array.isArray(style.stats)
      ? style.stats.slice(0, 30).map((s) => ({
          key: String(s?.key || "").trim().slice(0, 60),
          label: String(s?.label || "").trim().slice(0, 60),
          value: clampNum(s?.value, 0, 0, 100),
          grade: String(s?.grade || "E").trim().slice(0, 8),
        })).filter((s) => s.key)
      : [],
    stanceHint: String(style.stanceHint || "").trim().slice(0, 500),
  };
}

// styleDescriptor：从 name+style 拼一段文本供插件当作 personaText 用，截断到 ~600 字。
function computeStyleDescriptor(name, style) {
  const summary = String(style?.summary || "").trim();
  const catchphrases = Array.isArray(style?.catchphrases) ? style.catchphrases.filter(Boolean) : [];
  const stanceHint = String(style?.stanceHint || "").trim();
  const parts = [String(name || "").trim()];
  if (summary) parts.push(`风格：${summary}`);
  if (catchphrases.length) parts.push(`口头禅：${catchphrases.join("、")}`);
  if (stanceHint) parts.push(`倾向：${stanceHint}`);
  return parts.join("｜").slice(0, 600);
}

// ── 序列化（严格对齐冻结契约 Persona）─────────────────────────────
function serializeStat(s) {
  return {
    key: s?.key || "",
    label: s?.label || "",
    value: Number(s?.value || 0),
    grade: s?.grade || "E",
  };
}

function serializeStyle(style) {
  return {
    summary: String(style?.summary || ""),
    catchphrases: Array.isArray(style?.catchphrases) ? style.catchphrases : [],
    stats: Array.isArray(style?.stats) ? style.stats.map(serializeStat) : [],
    stanceHint: String(style?.stanceHint || ""),
  };
}

function toPersonaPayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: doc.author && typeof doc.author === "object"
      ? { _id: doc.author._id, username: doc.author.username }
      : doc.author,
    name: doc.name,
    description: doc.description || "",
    standName: doc.standName || "",
    coverEmoji: doc.coverEmoji || "🎭",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    style: serializeStyle(doc.style),
    styleDescriptor: computeStyleDescriptor(doc.name, doc.style),
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      downloadCount: Number(doc?.stats?.downloadCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
    },
    installed: !!ctx.installed,
    liked: !!ctx.liked,
    equipped: !!ctx.equipped,
    isOwner: !!ctx.isOwner,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function ownedBy(doc, user) {
  return !!user && String(user._id) === String(doc.author?._id || doc.author);
}

async function loadUserContext(user, docs) {
  if (!user || !docs.length) return { installedSet: new Set(), likedSet: new Set(), equippedId: null };
  const ids = docs.map((d) => d._id);
  const [installs, likes, equip] = await Promise.all([
    PersonaInstall.find({ user: user._id, persona: { $in: ids } }).select("persona").lean(),
    PersonaLike.find({ user: user._id, persona: { $in: ids } }).select("persona").lean(),
    PersonaEquip.findOne({ user: user._id }).select("persona").lean(),
  ]);
  return {
    installedSet: new Set(installs.map((x) => String(x.persona))),
    likedSet: new Set(likes.map((x) => String(x.persona))),
    equippedId: equip && equip.persona ? String(equip.persona) : null,
  };
}

// ── list ─────────────────────────────────────────────────────────

async function listPersonas(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10) || 12, 1), 40);
    const sort = String(req.query.sort || "new").toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const tag = String(req.query.tag || "").trim().toLowerCase();

    let scope = String(req.query.scope || "all").toLowerCase();
    if (!["all", "installed", "mine"].includes(scope)) scope = "all";
    // installed/mine 需登录，未登录当 all 处理
    if ((scope === "installed" || scope === "mine") && !req.user) scope = "all";

    let filter;
    if (scope === "mine") {
      filter = { author: req.user._id };
    } else if (scope === "installed") {
      const installs = await PersonaInstall.find({ user: req.user._id }).select("persona").lean();
      filter = { _id: { $in: installs.map((x) => x.persona) } };
    } else {
      filter = { shared: true };
    }
    if (tag) filter.tags = tag;

    let items = await Persona.find(filter).populate("author", "_id username").lean();

    if (q) {
      items = items.filter((item) => {
        const hay = `${item.name || ""} ${item.description || ""} ${item.standName || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (sort === "hot") {
      items.sort((a, b) => {
        const ha = Number(a?.stats?.downloadCount || 0) + Number(a?.stats?.likeCount || 0);
        const hb = Number(b?.stats?.downloadCount || 0) + Number(b?.stats?.likeCount || 0);
        if (hb !== ha) return hb - ha;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else {
      items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    }

    const total = items.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const paged = items.slice((page - 1) * limit, page * limit);

    const { installedSet, likedSet, equippedId } = await loadUserContext(req.user, paged);

    res.json({
      ok: true,
      personas: paged.map((item) => toPersonaPayload(item, {
        installed: installedSet.has(String(item._id)),
        liked: likedSet.has(String(item._id)),
        equipped: equippedId != null && String(item._id) === equippedId,
        isOwner: ownedBy(item, req.user),
      })),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

async function getPersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const existing = await Persona.findById(id).lean();
    if (!existing) notFound("Persona not found");

    const isOwner = ownedBy(existing, req.user);
    if (!existing.shared && !isOwner) forbidden("Forbidden");

    let installed = false;
    let liked = false;
    let equipped = false;
    if (req.user) {
      const [inst, lk, eq] = await Promise.all([
        PersonaInstall.exists({ user: req.user._id, persona: id }),
        PersonaLike.exists({ user: req.user._id, persona: id }),
        PersonaEquip.findOne({ user: req.user._id }).select("persona").lean(),
      ]);
      installed = !!inst;
      liked = !!lk;
      equipped = !!(eq && eq.persona && String(eq.persona) === String(id));
    }

    await Persona.updateOne({ _id: id }, { $inc: { "stats.viewCount": 1 } });
    const refreshed = await Persona.findById(id).populate("author", "_id username").lean();

    res.json({
      ok: true,
      persona: toPersonaPayload(refreshed, { installed, liked, equipped, isOwner }),
    });
  } catch (err) {
    next(err);
  }
}

async function createPersona(req, res, next) {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) badRequest("Name is required");

    const doc = await Persona.create({
      author: req.user._id,
      name: name.slice(0, 120),
      description: String(req.body.description || "").trim().slice(0, 1000),
      standName: String(req.body.standName || "").trim().slice(0, 120),
      coverEmoji: normalizeEmoji(req.body.coverEmoji),
      tags: toTags(req.body.tags),
      style: normalizeStyle(req.body.style),
      shared: Boolean(req.body.shared),
    });

    const populated = await Persona.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, persona: toPersonaPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function updatePersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const doc = await Persona.findById(id);
    if (!doc) notFound("Persona not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.name !== undefined) doc.name = String(req.body.name || "").trim().slice(0, 120);
    if (req.body.description !== undefined) doc.description = String(req.body.description || "").trim().slice(0, 1000);
    if (req.body.standName !== undefined) doc.standName = String(req.body.standName || "").trim().slice(0, 120);
    if (req.body.coverEmoji !== undefined) doc.coverEmoji = normalizeEmoji(req.body.coverEmoji);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.style !== undefined) doc.style = normalizeStyle(req.body.style);
    if (req.body.shared !== undefined) doc.shared = Boolean(req.body.shared);

    await doc.save();
    const populated = await Persona.findById(doc._id).populate("author", "_id username").lean();
    res.json({ ok: true, persona: toPersonaPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function removePersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const doc = await Persona.findById(id);
    if (!doc) notFound("Persona not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      Persona.deleteOne({ _id: id }),
      PersonaInstall.deleteMany({ persona: id }),
      PersonaLike.deleteMany({ persona: id }),
      // 有人装备了这个人格则回落到本人风格
      PersonaEquip.updateMany({ persona: id }, { $set: { persona: null } }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function installPersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const persona = await Persona.findById(id).select("_id author shared").lean();
    if (!persona) notFound("Persona not found");
    if (!persona.shared && String(persona.author) !== String(req.user._id)) forbidden("Forbidden");

    // 幂等：已装则不重复计数
    await PersonaInstall.updateOne(
      { user: req.user._id, persona: id },
      { $setOnInsert: { user: req.user._id, persona: id } },
      { upsert: true }
    );

    const downloadCount = await PersonaInstall.countDocuments({ persona: id });
    await Persona.updateOne({ _id: id }, { $set: { "stats.downloadCount": downloadCount } });

    res.json({ ok: true, installed: true, downloadCount });
  } catch (err) {
    next(err);
  }
}

async function uninstallPersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const persona = await Persona.findById(id).select("_id").lean();
    if (!persona) notFound("Persona not found");

    await PersonaInstall.deleteOne({ user: req.user._id, persona: id });

    const downloadCount = await PersonaInstall.countDocuments({ persona: id });
    await Persona.updateOne({ _id: id }, { $set: { "stats.downloadCount": downloadCount } });

    res.json({ ok: true, installed: false, downloadCount });
  } catch (err) {
    next(err);
  }
}

async function togglePersonaLike(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const persona = await Persona.findById(id).select("_id author shared").lean();
    if (!persona) notFound("Persona not found");
    if (!persona.shared && String(persona.author) !== String(req.user._id)) forbidden("Forbidden");

    const exists = await PersonaLike.findOne({ user: req.user._id, persona: id });
    let liked = false;
    if (exists) {
      await PersonaLike.deleteOne({ _id: exists._id });
      liked = false;
    } else {
      try {
        await PersonaLike.create({ user: req.user._id, persona: id });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // 并发重复请求：已点赞，幂等
      }
      liked = true;
    }

    const likeCount = await PersonaLike.countDocuments({ persona: id });
    await Persona.updateOne({ _id: id }, { $set: { "stats.likeCount": likeCount } });

    res.json({ ok: true, liked, likeCount });
  } catch (err) {
    next(err);
  }
}

// GET /api/personas/equipped —— 当前装备（null=本人风格）
async function getEquipped(req, res, next) {
  try {
    const eq = await PersonaEquip.findOne({ user: req.user._id }).lean();
    if (!eq || !eq.persona) {
      return res.json({ ok: true, equipped: null });
    }

    const persona = await Persona.findById(eq.persona).populate("author", "_id username").lean();
    if (!persona) {
      return res.json({ ok: true, equipped: null });
    }

    const [inst, lk] = await Promise.all([
      PersonaInstall.exists({ user: req.user._id, persona: persona._id }),
      PersonaLike.exists({ user: req.user._id, persona: persona._id }),
    ]);

    res.json({
      ok: true,
      equipped: toPersonaPayload(persona, {
        installed: !!inst,
        liked: !!lk,
        equipped: true,
        isOwner: ownedBy(persona, req.user),
      }),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/personas/equip —— 装备某人格或切回本人风格（personaId=null）
async function equipPersona(req, res, next) {
  try {
    const personaId = req.body.personaId ?? null;

    // 切回本人风格
    if (personaId === null || personaId === "") {
      await PersonaEquip.findOneAndUpdate(
        { user: req.user._id },
        { $set: { persona: null } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return res.json({ ok: true, equipped: null });
    }

    if (!isValidId(personaId)) invalidId("Invalid persona id");

    const persona = await Persona.findById(personaId).select("_id author shared").lean();
    if (!persona) notFound("Persona not found");
    if (!persona.shared && String(persona.author) !== String(req.user._id)) forbidden("Forbidden");

    // 装备时确保 install 存在（未收藏则自动收藏）
    const exists = await PersonaInstall.findOne({ user: req.user._id, persona: personaId }).select("_id").lean();
    if (!exists) {
      await PersonaInstall.updateOne(
        { user: req.user._id, persona: personaId },
        { $setOnInsert: { user: req.user._id, persona: personaId } },
        { upsert: true }
      );
      const downloadCount = await PersonaInstall.countDocuments({ persona: personaId });
      await Persona.updateOne({ _id: personaId }, { $set: { "stats.downloadCount": downloadCount } });
    }

    await PersonaEquip.findOneAndUpdate(
      { user: req.user._id },
      { $set: { persona: personaId } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const populated = await Persona.findById(personaId).populate("author", "_id username").lean();
    const liked = await PersonaLike.exists({ user: req.user._id, persona: personaId });

    res.json({
      ok: true,
      equipped: toPersonaPayload(populated, {
        installed: true,
        liked: !!liked,
        equipped: true,
        isOwner: ownedBy(populated, req.user),
      }),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  removePersona,
  installPersona,
  uninstallPersona,
  togglePersonaLike,
  getEquipped,
  equipPersona,
};
