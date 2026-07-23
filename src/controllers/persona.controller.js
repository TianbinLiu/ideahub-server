// src/controllers/persona.controller.js
// 人格下载（Persona）控制器：广场/收藏/发布列表、详情（$inc view）、增删改（owner 校验）、
// 收藏下载（install/uninstall）、点赞（toggle）、装备（equip/equipped）。
const mongoose = require("mongoose");
const Persona = require("../models/Persona");
const PersonaInstall = require("../models/PersonaInstall");
const PersonaLike = require("../models/PersonaLike");
const PersonaEquip = require("../models/PersonaEquip");
const PersonaPurchase = require("../models/PersonaPurchase");
const { generatePersonaFromChat } = require("../services/personaAi.service");
const { purchasePersonaTransfer, personaFee } = require("../services/points.service");
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

/** 封面图 URL 归一：只收 http(s) 或站内相对路径，其余置空（与 bounty/scenario 同款防注入） */
function normalizeSafeUrl(input) {
  const raw = String(input || "").trim().slice(0, 2000);
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return "";
  }
  return "";
}

/** 售价归一：非负整数点数，上限与模型一致；非法输入一律 0（免费） */
function toPrice(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 100000);
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
    // 每条 slice(0,120) 与 schemas 的 styleBody max(120) 对齐（zod 拒绝不截断；
    // generate 草稿走这里归一后必须是合法的 create 入参，否则「创建并绑定」会 400）
    catchphrases: Array.isArray(style.catchphrases)
      ? style.catchphrases.map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean).slice(0, 50)
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
    coverEmoji: doc.coverEmoji || "🎭",
    coverImageUrl: doc.coverImageUrl || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    style: serializeStyle(doc.style),
    styleDescriptor: computeStyleDescriptor(doc.name, doc.style),
    // shared 一直漏序列化（client Persona 类型早已声明）：编辑器回填 setShared(!!p.shared)
    // 拿到 undefined → 勾选框永远显示未勾选 → 用户编辑公开人格随手保存就把它静默改私有。
    shared: !!doc.shared,
    price: Number(doc.price || 0),
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      downloadCount: Number(doc?.stats?.downloadCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
    },
    installed: !!ctx.installed,
    liked: !!ctx.liked,
    equipped: !!ctx.equipped,
    isOwner: !!ctx.isOwner,
    // 观看者是否已购买（永久解锁）。作者本人恒 false —— gate 处一律先判 isOwner。
    purchased: !!ctx.purchased,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function ownedBy(doc, user) {
  return !!user && String(user._id) === String(doc.author?._id || doc.author);
}

async function loadUserContext(user, docs) {
  if (!user || !docs.length)
    return { installedSet: new Set(), likedSet: new Set(), equippedId: null, purchasedSet: new Set() };
  const ids = docs.map((d) => d._id);
  const [installs, likes, equip, purchases] = await Promise.all([
    PersonaInstall.find({ user: user._id, persona: { $in: ids } }).select("persona").lean(),
    PersonaLike.find({ user: user._id, persona: { $in: ids } }).select("persona").lean(),
    PersonaEquip.findOne({ user: user._id }).select("persona").lean(),
    // settledAt 非空才算已购：pending claim 不具备解锁效力（见 PersonaPurchase 模型注释）
    PersonaPurchase.find({ user: user._id, persona: { $in: ids }, settledAt: { $ne: null } }).select("persona").lean(),
  ]);
  return {
    installedSet: new Set(installs.map((x) => String(x.persona))),
    likedSet: new Set(likes.map((x) => String(x.persona))),
    equippedId: equip && equip.persona ? String(equip.persona) : null,
    purchasedSet: new Set(purchases.map((x) => String(x.persona))),
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
      // 只列【仍可用】的收藏（公开的，或自己发布的）。作者取消分享后 install 记录还在，
      // 但收藏者连详情都打不开（getPersona 对 !shared && !owner 是 403）——列表里留着
      // 只会产出「点不开的卡」，而情景编辑器的人格选择器也走这个接口：选了一个
      // play 时永远不生效（resolveParticipantPersonas 判不可用）的人格 = 绑定即死链。
      filter = {
        _id: { $in: installs.map((x) => x.persona) },
        $or: [{ shared: true }, { author: req.user._id }],
      };
    } else {
      filter = { shared: true };
    }
    if (tag) filter.tags = tag;

    let items = await Persona.find(filter).populate("author", "_id username").lean();

    if (q) {
      items = items.filter((item) => {
        const hay = `${item.name || ""} ${item.description || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
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

    const { installedSet, likedSet, equippedId, purchasedSet } = await loadUserContext(req.user, paged);

    res.json({
      ok: true,
      personas: paged.map((item) => toPersonaPayload(item, {
        installed: installedSet.has(String(item._id)),
        liked: likedSet.has(String(item._id)),
        equipped: equippedId != null && String(item._id) === equippedId,
        isOwner: ownedBy(item, req.user),
        purchased: purchasedSet.has(String(item._id)),
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
    let purchased = false;
    if (req.user) {
      const [inst, lk, eq, pur] = await Promise.all([
        PersonaInstall.exists({ user: req.user._id, persona: id }),
        PersonaLike.exists({ user: req.user._id, persona: id }),
        PersonaEquip.findOne({ user: req.user._id }).select("persona").lean(),
        PersonaPurchase.exists({ user: req.user._id, persona: id, settledAt: { $ne: null } }),
      ]);
      installed = !!inst;
      liked = !!lk;
      equipped = !!(eq && eq.persona && String(eq.persona) === String(id));
      purchased = !!pur;
    }

    await Persona.updateOne({ _id: id }, { $inc: { "stats.viewCount": 1 } });
    const refreshed = await Persona.findById(id).populate("author", "_id username").lean();

    res.json({
      ok: true,
      persona: toPersonaPayload(refreshed, { installed, liked, equipped, isOwner, purchased }),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/personas/generate —— 从聊天文本提炼人格【草稿】（不落库）。
// 客户端预览草稿后走既有 POST /api/personas 创建（shared 由用户在预览时勾选），
// 用户取消不会留孤儿人格。归一复用 create 同款 helper，保证草稿即创建合法入参。
async function generatePersona(req, res, next) {
  try {
    const draft = await generatePersonaFromChat({
      chatText: req.body.chatText,
      hint: req.body.hint,
    });
    res.json({
      ok: true,
      draft: {
        name: draft.name,
        description: draft.description,
        coverEmoji: normalizeEmoji(draft.coverEmoji),
        tags: toTags(draft.tags),
        style: normalizeStyle(draft.style),
      },
      model: draft.model,
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
      coverEmoji: normalizeEmoji(req.body.coverEmoji),
      coverImageUrl: normalizeSafeUrl(req.body.coverImageUrl),
      tags: toTags(req.body.tags),
      style: normalizeStyle(req.body.style),
      shared: Boolean(req.body.shared),
      price: toPrice(req.body.price),
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
    if (req.body.coverEmoji !== undefined) doc.coverEmoji = normalizeEmoji(req.body.coverEmoji);
    if (req.body.coverImageUrl !== undefined) doc.coverImageUrl = normalizeSafeUrl(req.body.coverImageUrl);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.style !== undefined) doc.style = normalizeStyle(req.body.style);
    if (req.body.shared !== undefined) doc.shared = Boolean(req.body.shared);
    // 调价只影响后续购买：已购用户是永久解锁（PersonaPurchase 记录成交价快照）
    if (req.body.price !== undefined) doc.price = toPrice(req.body.price);

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

/**
 * POST /api/personas/:id/purchase —— 用赏金点数购买付费人格（永久解锁选用权）。
 *
 * 顺序是「先 claim 记录、转账失败再补偿删除」：
 * - 幂等/并发：PersonaPurchase 的 {user,persona} 唯一索引保证并发双击只有一个 claim 成功，
 *   另一个拿 duplicate key → 视作已购返回，不会扣两次款。
 * - 失败补偿：claim 成功但转账失败（点数不足/创作者被删）→ 删掉 claim 再抛错，
 *   不会出现「没花钱却解锁」的残留记录。
 */
async function purchasePersona(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid persona id");

    const persona = await Persona.findById(id).select("_id author shared price name").lean();
    if (!persona) notFound("Persona not found");
    if (String(persona.author) === String(req.user._id)) badRequest("自己的人格无需购买");
    if (!persona.shared) forbidden("Forbidden");

    const price = Number(persona.price || 0);
    if (price <= 0) badRequest("该人格是免费的，无需购买");

    // 价格钉住（防 TOCTOU，评审实锤）：客户端确认弹层展示的是取列表时的价格，作者可能
    // 在弹层打开期间调价 —— 带上 expectedPrice，不一致就拒绝，绝不按用户没见过的价格扣款。
    if (req.body && req.body.expectedPrice !== undefined) {
      const expected = Number(req.body.expectedPrice);
      if (!Number.isInteger(expected) || expected !== price) {
        badRequest("价格已更新，请刷新后按最新价格确认购买");
      }
    }

    // 已有记录：settled = 真已购，幂等返回；pending = 另一请求正在支付（新鲜）
    // 或上次进程崩溃的残留（陈旧，清掉重来）。pending 一律【不】当已购 —— 否则
    // 「余额不足 + 并发双击」会给输家返回假成功（评审实锤）。
    const PENDING_STALE_MS = 60 * 1000;
    const existing = await PersonaPurchase.findOne({ user: req.user._id, persona: id })
      .select("_id settledAt createdAt")
      .lean();
    if (existing) {
      if (existing.settledAt) {
        return res.json({ ok: true, purchased: true, alreadyOwned: true, price });
      }
      if (Date.now() - new Date(existing.createdAt).getTime() < PENDING_STALE_MS) {
        badRequest("购买正在处理中，请稍后重试");
      }
      await PersonaPurchase.deleteOne({ _id: existing._id, settledAt: null });
    }

    // claim（唯一索引挡并发；pending 态，结算前不具备任何解锁效力）
    let claim;
    try {
      claim = await PersonaPurchase.create({
        user: req.user._id,
        persona: id,
        price,
        fee: personaFee(price),
      });
    } catch (e) {
      if (e && e.code === 11000) {
        // 撞上并发对手的 claim：对手可能已结算（真已购）也可能还在支付中
        const winner = await PersonaPurchase.findOne({ user: req.user._id, persona: id })
          .select("settledAt")
          .lean();
        if (winner && winner.settledAt) {
          return res.json({ ok: true, purchased: true, alreadyOwned: true, price });
        }
        badRequest("购买正在处理中，请稍后重试");
      }
      throw e;
    }

    try {
      const { buyerBalance } = await purchasePersonaTransfer({
        personaId: id,
        buyerId: req.user._id,
        creatorId: persona.author,
        price,
        memo: `购买人格「${persona.name}」`,
      });
      await PersonaPurchase.updateOne({ _id: claim._id }, { $set: { settledAt: new Date() } });
      res.json({ ok: true, purchased: true, alreadyOwned: false, price, balance: buyerBalance });
    } catch (err) {
      // ★补偿方向要看「钱动没动」（评审实锤）：
      // - badRequest（status 400：点数不足=原子扣款没成 / 创作者被删=已原样退款）
      //   ⇒ 账本一个字没写、余额已复原 → 撤销 claim，交易干净地不存在。
      // - 其它异常（DB/网络故障，比如扣款成功后写分录失败）⇒ 钱【可能已动】。
      //   此时删 claim = 收走买家已付款的解锁，重试还会二次扣款 —— 方向反了。
      //   改为：保留 claim 并置 settled（宁可平台送一次解锁，不能吞用户的钱），
      //   打日志供人工对账（账本可能缺分录，「余额=流水和」的审计会指到这里）。
      if (Number(err && err.status) === 400) {
        await PersonaPurchase.deleteOne({ _id: claim._id });
      } else {
        console.error("[personaPurchase] 转账异常且钱可能已动，保留解锁待人工对账", {
          claimId: String(claim._id),
          persona: String(id),
          buyer: String(req.user._id),
          err: err && err.message,
        });
        await PersonaPurchase.updateOne({ _id: claim._id }, { $set: { settledAt: new Date() } });
      }
      throw err;
    }
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

    const persona = await Persona.findById(personaId).select("_id author shared price").lean();
    if (!persona) notFound("Persona not found");
    const isOwnPersona = String(persona.author) === String(req.user._id);
    if (!persona.shared && !isOwnPersona) forbidden("Forbidden");

    // 付费人格：装备也是「选用」，需先购买（作者自己免）
    if (Number(persona.price || 0) > 0 && !isOwnPersona) {
      const bought = await PersonaPurchase.exists({ user: req.user._id, persona: personaId, settledAt: { $ne: null } });
      if (!bought) badRequest("该人格为付费人格，需先购买");
    }

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
  generatePersona,
  createPersona,
  updatePersona,
  removePersona,
  purchasePersona,
  installPersona,
  uninstallPersona,
  togglePersonaLike,
  getEquipped,
  equipPersona,
  // 供情景模拟复用：chat 场景 play 时按 participants.personaId 实时算人设文本喂 AI
  // （见 scenario.controller.js 的 resolveParticipantPersonas）。
  computeStyleDescriptor,
};
