const mongoose = require("mongoose");
const Scenario = require("../models/Scenario");
const ScenarioLike = require("../models/ScenarioLike");
const ScenarioBookmark = require("../models/ScenarioBookmark");
const ScenarioMessage = require("../models/ScenarioMessage");
const { generateRolePlayReplies, generateSeedComments } = require("../services/scenarioAi.service");
const scraperController = require("./scraper.controller");
const { badRequest, forbidden, notFound, invalidId } = require("../utils/http");

// 从 model 取，别在这里再抄一份 —— 两处各写一份数组正是「插件认得 douyin、
// 后端却把它降级成 generic」这类漂移的来源。
const PLATFORMS = Scenario.SCENARIO_PLATFORMS;

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function clampInt(value, fallback, min, max) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizePlatform(input) {
  const value = String(input || "").trim().toLowerCase();
  return PLATFORMS.includes(value) ? value : "generic";
}

// URL 域名 → 平台。
//
// ★★ 两处必须同步改 ★★
// 这里的域名规则与【插件仓库】 ideahub-arena-extension/src/content.js 的 detectPlatform()
// 是【同一套判定的两份实现】：插件在页面上按 location.hostname 判平台并把 platform 随抓取结果
// 提交过来，本函数则在用户直接贴 URL 时判平台。两边只要不一致，就会出现
// 「插件说是 douyin、后端按 generic 存」这种静默错配 —— 用户看到的皮肤直接退化。
// ⇒ 改任何一处，另一处必须跟着改。
//
// 与 detectPlatform 的【逐条对齐】现状：
//   detectPlatform                              | 本函数
//   ----------------------------------------------------------------
//   /bilibili\.com|b23\.tv/        → bilibili    | ✅ 一致
//   /weibo\.(com|cn)/             → weibo       | ✅ 一致
//   /tieba\.baidu\.com/           → tieba       | ✅ 一致
//   /zhihu\.com/                  → zhihu       | ✅ 一致
//   /instagram\.com/              → instagram   | ✅ 一致
//   /douyin\.com/                 → douyin      | ✅ 一致（本次补齐）
//   /xiaohongshu\.com|xhslink\.com/ → xiaohongshu| ✅ 一致（本次补齐）
//   /(^|\.)x\.com|twitter\.com/   → twitter     | ❌ 本次不接：没做皮肤，接了也只会 fallback 到 generic
//   /youtube\.com|youtu\.be/      → youtube     | ❌ 同上
//   /reddit\.com/                 → reddit      | ❌ 同上
// 即：插件仍会把 twitter/youtube/reddit 报上来，本函数与 normalizePlatform 都把它们归入 generic。
// 这是【有意为之】的取舍，不是遗漏；等为它们做了皮肤，再连同 SCENARIO_PLATFORMS 一起加。
function platformFromHost(host) {
  const h = String(host || "").toLowerCase();
  if (h.includes("bilibili.com") || h.includes("b23.tv")) return "bilibili";
  if (h.includes("weibo.com") || h.includes("weibo.cn")) return "weibo";
  if (h.includes("tieba.baidu.com")) return "tieba";
  if (h.includes("zhihu.com")) return "zhihu";
  if (h.includes("instagram.com")) return "instagram";
  if (h.includes("douyin.com")) return "douyin";
  if (h.includes("xiaohongshu.com") || h.includes("xhslink.com")) return "xiaohongshu";
  return "generic";
}

function normalizeSafeUrl(input) {
  const raw = String(input || "").trim().slice(0, 2000);
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return "";

  if (raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return "";
  }

  return "";
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

function genId() {
  return `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeComments(raw) {
  if (!Array.isArray(raw)) return [];
  const list = raw.slice(0, 200);
  const used = new Set();
  let opAssigned = false;

  const out = list.map((c) => {
    let id = String(c?.id || "").trim().slice(0, 120);
    if (!id || used.has(id)) id = genId();
    used.add(id);

    const parentRaw = c?.parentId;
    let parentId = parentRaw !== null && parentRaw !== undefined && String(parentRaw).trim()
      ? String(parentRaw).trim().slice(0, 120)
      : null;
    if (parentId === id) parentId = null; // 断开自引用回复，避免层级环

    // 至多一个楼主：保留首个 isOP，其余置 false（与 AI 生成路径一致）
    let isOP = Boolean(c?.isOP);
    if (isOP && !opAssigned) opAssigned = true;
    else isOP = false;

    return {
      id,
      authorName: String(c?.authorName || "").trim().slice(0, 80) || "匿名",
      authorAvatar: normalizeSafeUrl(c?.authorAvatar),
      text: String(c?.text || "").trim().slice(0, 2000),
      likeCount: clampInt(c?.likeCount, 0, 0, 100000000),
      parentId,
      isOP,
      stance: String(c?.stance || "").trim().slice(0, 200),
    };
  });

  const ids = new Set(out.map((c) => c.id));
  for (const c of out) {
    if (c.parentId && !ids.has(c.parentId)) c.parentId = null;
  }

  return out;
}

function serializeComment(c) {
  return {
    id: c?.id,
    authorName: c?.authorName || "",
    authorAvatar: c?.authorAvatar || "",
    text: c?.text || "",
    likeCount: Number(c?.likeCount || 0),
    parentId: c?.parentId ?? null,
    isOP: !!c?.isOP,
    stance: c?.stance || "",
  };
}

function toScenarioPayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    author: doc.author && typeof doc.author === "object"
      ? { _id: doc.author._id, username: doc.author.username }
      : doc.author,
    title: doc.title,
    summary: doc.summary || "",
    coverImageUrl: doc.coverImageUrl || "",
    platform: doc.platform || "generic",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    shared: !!doc.shared,
    sourceUrl: doc.sourceUrl || "",
    topic: doc.topic || "",
    comments: Array.isArray(doc.comments) ? doc.comments.map(serializeComment) : [],
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
      bookmarkCount: Number(doc?.stats?.bookmarkCount || 0),
      playCount: Number(doc?.stats?.playCount || 0),
    },
    liked: !!ctx.liked,
    bookmarked: !!ctx.bookmarked,
    isOwner: !!ctx.isOwner,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toScenarioCard(doc, ctx = {}) {
  const payload = toScenarioPayload(doc, ctx);
  if (!payload) return null;
  const { comments, ...card } = payload;
  return card;
}

function scoreForYou(doc) {
  return Number(doc?.stats?.viewCount || 0) * 0.05
    + Number(doc?.stats?.likeCount || 0) * 8
    + Number(doc?.stats?.bookmarkCount || 0) * 6;
}

async function loadUserSets(user, docs) {
  if (!user || !docs.length) return { likedSet: new Set(), bookmarkedSet: new Set() };
  const ids = docs.map((d) => d._id);
  const [likes, bookmarks] = await Promise.all([
    ScenarioLike.find({ user: user._id, scenario: { $in: ids } }).select("scenario").lean(),
    ScenarioBookmark.find({ user: user._id, scenario: { $in: ids } }).select("scenario").lean(),
  ]);
  return {
    likedSet: new Set(likes.map((x) => String(x.scenario))),
    bookmarkedSet: new Set(bookmarks.map((x) => String(x.scenario))),
  };
}

function ownedBy(doc, user) {
  return !!user && String(user._id) === String(doc.author?._id || doc.author);
}

// ── list ─────────────────────────────────────────────────────────

async function listScenarios(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10) || 12, 1), 40);
    const sort = String(req.query.sort || "for_you").toLowerCase();
    const q = String(req.query.q || "").trim().toLowerCase();
    const tag = String(req.query.tag || "").trim().toLowerCase();

    const filter = { shared: true };
    if (tag) filter.tags = tag;

    let items = await Scenario.find(filter).populate("author", "_id username").lean();

    if (q) {
      items = items.filter((item) => {
        const hay = `${item.title || ""} ${item.summary || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (sort === "new") {
      items.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    } else if (sort === "hot") {
      items.sort((a, b) => {
        const la = Number(a?.stats?.likeCount || 0);
        const lb = Number(b?.stats?.likeCount || 0);
        if (lb !== la) return lb - la;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else {
      items.sort((a, b) => {
        const sa = scoreForYou(a);
        const sb = scoreForYou(b);
        if (sb !== sa) return sb - sa;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    }

    const total = items.length;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const paged = items.slice((page - 1) * limit, page * limit);

    const { likedSet, bookmarkedSet } = await loadUserSets(req.user, paged);

    res.json({
      ok: true,
      scenarios: paged.map((item) => toScenarioCard(item, {
        liked: likedSet.has(String(item._id)),
        bookmarked: bookmarkedSet.has(String(item._id)),
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

async function listMyScenarios(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "12", 10) || 12, 1), 40);

    const filter = { author: req.user._id };
    const total = await Scenario.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    const items = await Scenario.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("author", "_id username")
      .lean();

    const { likedSet, bookmarkedSet } = await loadUserSets(req.user, items);

    res.json({
      ok: true,
      scenarios: items.map((item) => toScenarioCard(item, {
        liked: likedSet.has(String(item._id)),
        bookmarked: bookmarkedSet.has(String(item._id)),
        isOwner: true,
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

async function getScenarioDetail(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const existing = await Scenario.findById(id).lean();
    if (!existing) notFound("Scenario not found");

    const isOwner = ownedBy(existing, req.user);
    if (!existing.shared && !isOwner) forbidden("Forbidden");

    const [liked, bookmarked] = req.user
      ? await Promise.all([
          ScenarioLike.exists({ user: req.user._id, scenario: id }),
          ScenarioBookmark.exists({ user: req.user._id, scenario: id }),
        ])
      : [false, false];

    // 作者本人的浏览不计数，避免自刷 for_you/hot 排名
    if (!isOwner) {
      await Scenario.updateOne({ _id: id }, { $inc: { "stats.viewCount": 1 } });
    }
    const refreshed = await Scenario.findById(id).populate("author", "_id username").lean();

    res.json({
      ok: true,
      scenario: toScenarioPayload(refreshed, { liked: !!liked, bookmarked: !!bookmarked, isOwner: !!isOwner }),
    });
  } catch (err) {
    next(err);
  }
}

async function createScenario(req, res, next) {
  try {
    const title = String(req.body.title || "").trim();
    if (!title) badRequest("Title is required");

    const doc = await Scenario.create({
      author: req.user._id,
      title: title.slice(0, 120),
      summary: String(req.body.summary || "").trim().slice(0, 500),
      coverImageUrl: normalizeSafeUrl(req.body.coverImageUrl),
      platform: normalizePlatform(req.body.platform),
      tags: toTags(req.body.tags),
      shared: Boolean(req.body.shared),
      sourceUrl: normalizeSafeUrl(req.body.sourceUrl),
      topic: String(req.body.topic || "").trim().slice(0, 2000),
      comments: normalizeComments(req.body.comments),
    });

    const populated = await Scenario.findById(doc._id).populate("author", "_id username").lean();
    res.status(201).json({ ok: true, scenario: toScenarioPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function updateScenario(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const doc = await Scenario.findById(id);
    if (!doc) notFound("Scenario not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.title !== undefined) doc.title = String(req.body.title || "").trim().slice(0, 120);
    if (req.body.summary !== undefined) doc.summary = String(req.body.summary || "").trim().slice(0, 500);
    if (req.body.coverImageUrl !== undefined) doc.coverImageUrl = normalizeSafeUrl(req.body.coverImageUrl);
    if (req.body.platform !== undefined) doc.platform = normalizePlatform(req.body.platform);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.shared !== undefined) doc.shared = Boolean(req.body.shared);
    if (req.body.sourceUrl !== undefined) doc.sourceUrl = normalizeSafeUrl(req.body.sourceUrl);
    if (req.body.topic !== undefined) doc.topic = String(req.body.topic || "").trim().slice(0, 2000);
    if (req.body.comments !== undefined) doc.comments = normalizeComments(req.body.comments);

    await doc.save();
    const populated = await Scenario.findById(doc._id).populate("author", "_id username").lean();
    res.json({ ok: true, scenario: toScenarioPayload(populated, { isOwner: true }) });
  } catch (err) {
    next(err);
  }
}

async function removeScenario(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const doc = await Scenario.findById(id);
    if (!doc) notFound("Scenario not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      Scenario.deleteOne({ _id: id }),
      ScenarioLike.deleteMany({ scenario: id }),
      ScenarioBookmark.deleteMany({ scenario: id }),
      ScenarioMessage.deleteMany({ scenario: id }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function toggleScenarioLike(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const scenario = await Scenario.findById(id).select("_id author shared").lean();
    if (!scenario) notFound("Scenario not found");
    if (!scenario.shared && String(scenario.author) !== String(req.user._id)) forbidden("Forbidden");

    const exists = await ScenarioLike.findOne({ user: req.user._id, scenario: id });
    let liked = false;
    if (exists) {
      await ScenarioLike.deleteOne({ _id: exists._id });
      liked = false;
    } else {
      try {
        await ScenarioLike.create({ user: req.user._id, scenario: id });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // 并发重复请求：已点赞，幂等
      }
      liked = true;
    }

    const likeCount = await ScenarioLike.countDocuments({ scenario: id });
    await Scenario.updateOne({ _id: id }, { $set: { "stats.likeCount": likeCount } });

    res.json({ ok: true, liked, likeCount });
  } catch (err) {
    next(err);
  }
}

async function toggleScenarioBookmark(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const scenario = await Scenario.findById(id).select("_id author shared").lean();
    if (!scenario) notFound("Scenario not found");
    if (!scenario.shared && String(scenario.author) !== String(req.user._id)) forbidden("Forbidden");

    const exists = await ScenarioBookmark.findOne({ user: req.user._id, scenario: id });
    let bookmarked = false;
    if (exists) {
      await ScenarioBookmark.deleteOne({ _id: exists._id });
      bookmarked = false;
    } else {
      try {
        await ScenarioBookmark.create({ user: req.user._id, scenario: id });
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // 并发重复请求：已收藏，幂等
      }
      bookmarked = true;
    }

    const bookmarkCount = await ScenarioBookmark.countDocuments({ scenario: id });
    await Scenario.updateOne({ _id: id }, { $set: { "stats.bookmarkCount": bookmarkCount } });

    res.json({ ok: true, bookmarked, bookmarkCount });
  } catch (err) {
    next(err);
  }
}

async function playScenario(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid scenario id");

    const scenario = await Scenario.findById(id).lean();
    if (!scenario) notFound("Scenario not found");
    if (!scenario.shared && String(scenario.author) !== String(req.user._id)) forbidden("Forbidden");

    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const userMessage = req.body.userMessage || {};
    const userText = String(userMessage.text || "").trim();
    const userParentId = userMessage.parentId !== null && userMessage.parentId !== undefined && String(userMessage.parentId).trim()
      ? String(userMessage.parentId).trim().slice(0, 120)
      : null;
    // 前端传来的用户发言 id：AI 回复挂到这条用户发言下（真正“回应用户”），无则退回同层
    const userMsgId = String(userMessage.id || "").trim().slice(0, 120) || null;

    // 先调用 AI —— 若无 OPENAI_API_KEY(501) 或 AI 出错，直接进入 catch，
    // 不落库、不虚增 playCount（避免失败即污染数据 / 统计）。
    const { replies, model } = await generateRolePlayReplies({
      scenario,
      history,
      userMessage: { text: userText, parentId: userParentId },
    });

    // AI 成功后再做数据收集：持久化用户这条发言
    await ScenarioMessage.create({
      scenario: id,
      user: req.user._id,
      text: userText.slice(0, 4000),
      parentId: userParentId,
      platform: scenario.platform || "generic",
    });

    // 首次 play（该用户在此情景的第一条发言）时累计 playCount
    const priorCount = await ScenarioMessage.countDocuments({ scenario: id, user: req.user._id });
    if (priorCount <= 1) {
      await Scenario.updateOne({ _id: id }, { $inc: { "stats.playCount": 1 } });
    }

    const outReplies = (Array.isArray(replies) ? replies : []).map((r, i) => ({
      id: `ai_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      authorName: r.authorName,
      authorAvatar: r.authorAvatar || "",
      text: r.text,
      parentId: userMsgId || userParentId,
      isAi: true,
    }));

    res.json({ ok: true, replies: outReplies, model });
  } catch (err) {
    next(err);
  }
}

function invokeScraperFetch(url) {
  const fn = scraperController && scraperController.fetchExternalContent;
  if (typeof fn !== "function") return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const resLike = {
      json: (payload) => done(payload && typeof payload === "object" ? payload : null),
      status: () => resLike,
    };
    const reqLike = { body: { url }, headers: {}, get: () => "", protocol: "https" };

    try {
      Promise.resolve(fn(reqLike, resLike, () => done(null))).catch(() => done(null));
    } catch {
      done(null);
    }
  });
}

async function captureScenario(req, res, next) {
  try {
    const url = String(req.body.url || "").trim();

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      badRequest("Invalid URL");
    }
    // 协议校验放在解析之外，避免 badRequest 被内层 catch 吞成 "Invalid URL"
    if (!["http:", "https:"].includes(parsed.protocol)) badRequest("Only HTTP/HTTPS URLs are allowed");
    const host = parsed.hostname;

    const platform = platformFromHost(host);

    let title = "";
    let coverImageUrl = "";
    const scraped = await invokeScraperFetch(url);
    if (scraped) {
      title = String(scraped.title || "").trim().slice(0, 120);
      coverImageUrl = normalizeSafeUrl(scraped.coverImageUrl);
    }

    res.json({
      ok: true,
      draft: {
        platform,
        title,
        coverImageUrl,
        comments: [],
      },
    });
  } catch (err) {
    next(err);
  }
}

// 生成种子评论区。两条入口：topic（用户自拟话题）或 sourceText（真实评论素材）。
//
// ★★ sourceText 是【一次性入参】，只在本次请求的生命周期里存在：透传给 AI 当输入素材，
// 拿到 AI 重新生成的评论就丢弃。它【绝不】写进 Scenario 或任何其它 model，也【绝不】
// 出现在任何持久化字段里 —— 本函数不落库（只有 createScenario/updateScenario 落库，
// 而它们从不读 req.body.sourceText）。
// 理由（合规红线）：PIPL 第25条「不得公开其处理的个人信息」对「已合法公开的信息」没有豁免口；
// 只换名字而正文逐字保留属【去标识化】（拿原文一搜即可复原），不是【匿名化】。
// 故真实评论只作为 AI 的输入，发布出去的永远是 AI 重新生成的版本。
async function generateScenario(req, res, next) {
  try {
    const topic = String(req.body.topic || "").trim();
    const sourceText = String(req.body.sourceText || "").trim();
    if (!topic && !sourceText) badRequest("请提供话题或素材");

    const platform = normalizePlatform(req.body.platform);
    const intensity = ["mild", "heated", "flame"].includes(String(req.body.intensity))
      ? String(req.body.intensity)
      : "heated";
    const count = clampInt(req.body.count, 12, 4, 20);

    // 无 AI key 时 generateSeedComments 内的 requireKey() 抛 501 → next(err)，行为不变。
    const { comments, model } = await generateSeedComments({ topic, sourceText, platform, intensity, count });
    res.json({ ok: true, comments: normalizeComments(comments), model });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listScenarios,
  listMyScenarios,
  getScenarioDetail,
  createScenario,
  updateScenario,
  removeScenario,
  toggleScenarioLike,
  toggleScenarioBookmark,
  playScenario,
  captureScenario,
  generateScenario,
};
