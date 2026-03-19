const mongoose = require("mongoose");
const WorkshopTemplate = require("../models/WorkshopTemplate");
const WorkshopTemplateLike = require("../models/WorkshopTemplateLike");
const WorkshopTemplateBookmark = require("../models/WorkshopTemplateBookmark");
const WorkshopTemplateComment = require("../models/WorkshopTemplateComment");
const User = require("../models/User");
const { DEFAULT_WORKSHOP_LAYOUT } = require("../config/workshopLayout");
const { CURRENT_DEFAULT_TEMPLATE_VERSION } = require("../config/workshopVersion");
const { generateWorkshopEditPlan } = require("../services/workshopAi.service");
const { badRequest, invalidId, unauthorized, forbidden, notFound } = require("../utils/http");

const DEFAULT_TEMPLATE_ID = "default";

const SAFE_CSS_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-radius",
  "font-size",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding",
  "margin",
  "box-shadow",
  "opacity",
  "text-transform",
  "text-decoration",
]);

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
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

function scoreAgainstTags(template, tokens) {
  if (!tokens.length) return 0;
  const templateTags = Array.isArray(template?.tags)
    ? template.tags.map((tag) => String(tag || "").toLowerCase())
    : [];

  let score = 0;
  for (const token of tokens) {
    if (templateTags.some((tag) => tag === token)) score += 16;
    else if (templateTags.some((tag) => tag.includes(token) || token.includes(tag))) score += 8;
    if (String(template?.title || "").toLowerCase().includes(token)) score += 6;
    if (String(template?.summary || "").toLowerCase().includes(token)) score += 3;
  }
  return score;
}

function sanitizeCssBlock(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const lowered = raw.toLowerCase();
  if (/(^|\s)@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|<\/?style/i.test(lowered)) {
    return "";
  }

  const declarations = raw
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(":");
      if (idx <= 0) return null;
      const prop = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (!SAFE_CSS_PROPERTIES.has(prop) || !value) return null;
      return `${prop}: ${value}`;
    })
    .filter(Boolean)
    .slice(0, 40);

  return declarations.join("; ");
}

function normalizeSiteDraft(input) {
  const src = input && typeof input === "object" ? input : {};
  const pagesInput = src.pages && typeof src.pages === "object" ? src.pages : {};
  const pageEntries = Object.entries(pagesInput).slice(0, 40);
  const pages = {};

  for (const [rawPageKey, rawPageValue] of pageEntries) {
    const pageKey = String(rawPageKey || "").trim().slice(0, 120);
    if (!pageKey) continue;

    const pageValue = rawPageValue && typeof rawPageValue === "object" ? rawPageValue : {};
    const backgroundType = ["none", "image", "video", "gradient"].includes(String(pageValue.backgroundType || ""))
      ? String(pageValue.backgroundType)
      : "none";

    const nodesInput = pageValue.nodes && typeof pageValue.nodes === "object" ? pageValue.nodes : {};
    const nodeEntries = Object.entries(nodesInput).slice(0, 500);
    const nodes = {};

    for (const [rawNodeId, rawNodeValue] of nodeEntries) {
      const nodeId = String(rawNodeId || "").trim().slice(0, 200);
      if (!nodeId) continue;
      const nodeValue = rawNodeValue && typeof rawNodeValue === "object" ? rawNodeValue : {};

      nodes[nodeId] = {
        x: clampNumber(nodeValue.x, 0, -4000, 4000),
        y: clampNumber(nodeValue.y, 0, -4000, 4000),
        width: clampNumber(nodeValue.width, 0, 0, 8000),
        height: clampNumber(nodeValue.height, 0, 0, 8000),
        css: sanitizeCssBlock(nodeValue.css || ""),
      };
    }

    pages[pageKey] = {
      backgroundType,
      backgroundUrl: String(pageValue.backgroundUrl || "").trim().slice(0, 1000),
      nodes,
    };
  }

  return { pages };
}

function normalizeTheme(theme) {
  const src = theme && typeof theme === "object" ? theme : {};
  const backgroundType = ["none", "image", "video", "gradient"].includes(String(src.backgroundType || ""))
    ? String(src.backgroundType)
    : "none";

  return {
    backgroundType,
    backgroundUrl: String(src.backgroundUrl || "").trim().slice(0, 1000),
    accentColor: String(src.accentColor || "#22d3ee").trim().slice(0, 40),
    textColor: String(src.textColor || "#f3f4f6").trim().slice(0, 40),
    cardRadius: clampNumber(src.cardRadius, 16, 0, 48),
    cardOpacity: clampNumber(src.cardOpacity, 0.92, 0.25, 1),
    customCss: sanitizeCssBlock(src.customCss || ""),
    componentCss: {
      card: sanitizeCssBlock(src?.componentCss?.card || ""),
      button: sanitizeCssBlock(src?.componentCss?.button || ""),
      title: sanitizeCssBlock(src?.componentCss?.title || ""),
    },
  };
}

function createDefaultLayout() {
  return clone(DEFAULT_WORKSHOP_LAYOUT);
}

function normalizeLayout(layout) {
  const base = createDefaultLayout();
  const inputItems = Array.isArray(layout?.pages?.home?.items)
    ? layout.pages.home.items
    : Array.isArray(layout?.items)
      ? layout.items
      : [];
  const byId = new Map(inputItems.map((item) => [String(item?.id || ""), item]));

  const items = base.pages.home.items.map((defaultItem, index) => {
    const match = byId.get(defaultItem.id) || {};
    const width = clampNumber(match.w, defaultItem.w, 8, 96);
    const height = clampNumber(match.h, defaultItem.h, 6, 80);
    const x = clampNumber(match.x, defaultItem.x, 0, 100 - width);
    const y = clampNumber(match.y, defaultItem.y, 0, 100 - height);
    return {
      id: defaultItem.id,
      kind: defaultItem.kind,
      label: defaultItem.label,
      description: defaultItem.description,
      x,
      y,
      w: width,
      h: height,
      z: clampNumber(match.z, defaultItem.z ?? index + 1, 1, 99),
      visible: match.visible === undefined ? defaultItem.visible !== false : Boolean(match.visible),
    };
  }).sort((a, b) => a.z - b.z);

  return {
    version: 1,
    canvas: base.canvas,
    pages: {
      home: {
        items,
      },
    },
  };
}

function mergeLayout(baseLayout, partialLayout) {
  const current = normalizeLayout(baseLayout);
  const patchItems = Array.isArray(partialLayout?.items)
    ? partialLayout.items
    : Array.isArray(partialLayout?.pages?.home?.items)
      ? partialLayout.pages.home.items
      : [];
  const mergedItems = current.pages.home.items.map((item) => {
    const patch = patchItems.find((entry) => String(entry?.id || "") === item.id);
    if (!patch) return item;
    return {
      ...item,
      x: patch.x ?? item.x,
      y: patch.y ?? item.y,
      w: patch.w ?? item.w,
      h: patch.h ?? item.h,
      z: patch.z ?? item.z,
      visible: patch.visible ?? item.visible,
    };
  });
  return normalizeLayout({ items: mergedItems });
}

function createUpdateLogEntry({ title, summary, authorName, source }) {
  return {
    title: String(title || "Template updated").trim().slice(0, 80),
    summary: String(summary || "").trim().slice(0, 300),
    authorName: String(authorName || "").trim().slice(0, 80),
    source: ["manual", "ai", "system"].includes(String(source || "")) ? String(source) : "manual",
    createdAt: new Date(),
  };
}

function withCommentCount(payload, commentCount) {
  return {
    ...payload,
    stats: {
      ...(payload.stats || {}),
      commentCount,
    },
  };
}

function toTemplatePayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    title: doc.title,
    summary: doc.summary,
    previewImageUrl: doc.previewImageUrl,
    tags: doc.tags || [],
    templateVersion: doc.templateVersion || CURRENT_DEFAULT_TEMPLATE_VERSION,
    currentDefaultVersion: CURRENT_DEFAULT_TEMPLATE_VERSION,
    isCompatible: (doc.templateVersion || CURRENT_DEFAULT_TEMPLATE_VERSION) === CURRENT_DEFAULT_TEMPLATE_VERSION,
    isDefault: !!doc.isDefault,
    shared: !!doc.shared,
    theme: normalizeTheme(doc.theme),
    layout: normalizeLayout(doc.layout),
    siteDraft: normalizeSiteDraft(doc.siteDraft),
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
      bookmarkCount: Number(doc?.stats?.bookmarkCount || 0),
      commentCount: Number(doc?.stats?.commentCount || 0),
    },
    appliedCount: doc.appliedCount || 0,
    updateLogs: Array.isArray(doc.updateLogs) ? doc.updateLogs : [],
    author: doc.author && typeof doc.author === "object"
      ? { _id: doc.author._id, username: doc.author.username, role: doc.author.role }
      : doc.author,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    liked: !!ctx.liked,
    bookmarked: !!ctx.bookmarked,
  };
}

function buildDefaultTemplatePayload() {
  return toTemplatePayload({
    _id: DEFAULT_TEMPLATE_ID,
    title: "Default Website Template",
    summary: "The built-in baseline website frontend. This template evolves together with the product UI and always matches the current site version.",
    previewImageUrl: "",
    tags: ["default", "official", "baseline"],
    templateVersion: CURRENT_DEFAULT_TEMPLATE_VERSION,
    shared: true,
    isDefault: true,
    theme: {
      backgroundType: "none",
      backgroundUrl: "",
      accentColor: "#22d3ee",
      textColor: "#f3f4f6",
      cardRadius: 16,
      cardOpacity: 0.92,
      customCss: "",
      componentCss: { card: "", button: "", title: "" },
    },
    layout: createDefaultLayout(),
    siteDraft: { pages: {} },
    stats: { viewCount: 0, likeCount: 0, bookmarkCount: 0, commentCount: 0 },
    appliedCount: 0,
    updateLogs: [
      createUpdateLogEntry({
        title: `Default template ${CURRENT_DEFAULT_TEMPLATE_VERSION}`,
        summary: "Built-in baseline layout and theme for the current website version.",
        authorName: "IdeaHub",
        source: "system",
      }),
    ],
    author: { _id: null, username: "IdeaHub", role: "admin" },
    createdAt: null,
    updatedAt: null,
  });
}

async function assertTemplateReadable(id, user) {
  if (id === DEFAULT_TEMPLATE_ID) {
    return { isDefault: true, template: buildDefaultTemplatePayload() };
  }
  if (!isValidId(id)) invalidId("Invalid template id");
  const item = await WorkshopTemplate.findById(id).populate("author", "_id username role").lean();
  if (!item) notFound("Template not found");
  const isOwner = user && String(user._id) === String(item.author?._id || item.author);
  if (!item.shared && !isOwner) forbidden("Forbidden");
  return { isDefault: false, item, isOwner };
}

function normalizeDraftPayload(draft) {
  const src = draft && typeof draft === "object" ? draft : {};
  return {
    title: String(src.title || "").trim().slice(0, 80),
    summary: String(src.summary || "").trim().slice(0, 300),
    tags: toTags(src.tags),
    theme: normalizeTheme(src.theme),
    layout: normalizeLayout(src.layout),
  };
}

async function listTemplates(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 40);
    const sort = String(req.query.sort || "for_you").toLowerCase();
    const q = String(req.query.q || "").trim();
    const qTokens = toTags(q);
    const recentTokens = toTags(req.query.recentTags || "");

    const items = await WorkshopTemplate.find({ shared: true })
      .populate("author", "_id username role")
      .lean();

    const defaultTemplate = buildDefaultTemplatePayload();
    let mergedItems = [defaultTemplate, ...items.map((item) => toTemplatePayload(item))];

    if (qTokens.length > 0) {
      mergedItems = mergedItems.filter((item) => scoreAgainstTags(item, qTokens) > 0);
    }

    if (sort === "new") {
      mergedItems.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (b.isDefault && !a.isDefault) return 1;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else if (sort === "hot") {
      mergedItems.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (b.isDefault && !a.isDefault) return 1;
        const sa = Number(a?.stats?.viewCount || 0) * 0.05 + Number(a?.stats?.likeCount || 0) * 8 + Number(a?.stats?.bookmarkCount || 0) * 6;
        const sb = Number(b?.stats?.viewCount || 0) * 0.05 + Number(b?.stats?.likeCount || 0) * 8 + Number(b?.stats?.bookmarkCount || 0) * 6;
        if (sb !== sa) return sb - sa;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    } else {
      mergedItems.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (b.isDefault && !a.isDefault) return 1;
        const prefA = recentTokens.length > 0 ? scoreAgainstTags(a, recentTokens) : 0;
        const prefB = recentTokens.length > 0 ? scoreAgainstTags(b, recentTokens) : 0;
        if (prefB !== prefA) return prefB - prefA;
        const scoreA = prefA * 1.2 + Number(a?.stats?.viewCount || 0) * 0.04 + Number(a?.stats?.likeCount || 0) * 6 + Number(a?.stats?.bookmarkCount || 0) * 5;
        const scoreB = prefB * 1.2 + Number(b?.stats?.viewCount || 0) * 0.04 + Number(b?.stats?.likeCount || 0) * 6 + Number(b?.stats?.bookmarkCount || 0) * 5;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    }

    const total = mergedItems.length;
    const paged = mergedItems.slice((page - 1) * limit, page * limit);

    let likedSet = new Set();
    let bookmarkedSet = new Set();
    if (req.user && paged.length > 0) {
      const templateIds = paged.map((item) => item._id).filter((item) => item !== DEFAULT_TEMPLATE_ID);
      if (templateIds.length > 0) {
        const [likes, bookmarks] = await Promise.all([
          WorkshopTemplateLike.find({ user: req.user._id, template: { $in: templateIds } }).select("template").lean(),
          WorkshopTemplateBookmark.find({ user: req.user._id, template: { $in: templateIds } }).select("template").lean(),
        ]);

        likedSet = new Set(likes.map((x) => String(x.template)));
        bookmarkedSet = new Set(bookmarks.map((x) => String(x.template)));
      }
    }

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
      templates: paged.map((item) => ({
        ...item,
        liked: item.isDefault ? false : likedSet.has(String(item._id)),
        bookmarked: item.isDefault ? false : bookmarkedSet.has(String(item._id)),
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function listMyTemplates(req, res, next) {
  try {
    const items = await WorkshopTemplate.find({ author: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate("author", "_id username role")
      .lean();

    res.json({ ok: true, templates: items.map((item) => toTemplatePayload(item)) });
  } catch (err) {
    next(err);
  }
}

async function listTemplateTagInsights(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "240", 10), 1), 400);
    const items = await WorkshopTemplate.find({ shared: true })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("author", "_id username role")
      .lean();

    const templates = [buildDefaultTemplatePayload(), ...items.map((item) => toTemplatePayload(item))];
    const tagCount = new Map();

    for (const template of templates) {
      const uniqueTags = Array.from(new Set((template.tags || []).map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)));
      for (const tag of uniqueTags) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
    }

    const hotTags = [...tagCount.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 18)
      .map(([tag, count]) => ({ tag, count }));

    res.json({ ok: true, templates, hotTags });
  } catch (err) {
    next(err);
  }
}

async function getTemplateDetail(req, res, next) {
  try {
    const { id } = req.params;
    const readable = await assertTemplateReadable(id, req.user);

    if (readable.isDefault) {
      const commentCount = await WorkshopTemplateComment.countDocuments({ templateId: DEFAULT_TEMPLATE_ID });
      return res.json({ ok: true, template: withCommentCount(readable.template, commentCount) });
    }

    const [liked, bookmarked] = req.user
      ? await Promise.all([
          WorkshopTemplateLike.exists({ user: req.user._id, template: id }),
          WorkshopTemplateBookmark.exists({ user: req.user._id, template: id }),
        ])
      : [false, false];

    await WorkshopTemplate.updateOne({ _id: id }, { $inc: { "stats.viewCount": 1 } });
    const refreshed = await WorkshopTemplate.findById(id).populate("author", "_id username role").lean();
    res.json({ ok: true, template: toTemplatePayload(refreshed, { liked: !!liked, bookmarked: !!bookmarked }) });
  } catch (err) {
    next(err);
  }
}

async function createTemplate(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");

    const title = String(req.body.title || "").trim();
    if (!title) badRequest("Title is required");

    const doc = await WorkshopTemplate.create({
      author: req.user._id,
      title: title.slice(0, 80),
      summary: String(req.body.summary || "").trim().slice(0, 300),
      previewImageUrl: String(req.body.previewImageUrl || "").trim().slice(0, 1000),
      tags: toTags(req.body.tags),
      templateVersion: CURRENT_DEFAULT_TEMPLATE_VERSION,
      shared: Boolean(req.body.shared),
      theme: normalizeTheme(req.body.theme),
      layout: normalizeLayout(req.body.layout),
      siteDraft: normalizeSiteDraft(req.body.siteDraft),
      updateLogs: [
        createUpdateLogEntry({
          title: "Initial version",
          summary: String(req.body.changeSummary || "Template created in the workshop editor.").trim().slice(0, 300),
          authorName: req.user.username,
          source: "manual",
        }),
      ],
    });

    const populated = await WorkshopTemplate.findById(doc._id).populate("author", "_id username role").lean();
    res.status(201).json({ ok: true, template: toTemplatePayload(populated) });
  } catch (err) {
    next(err);
  }
}

async function updateTemplate(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const { id } = req.params;
    if (id === DEFAULT_TEMPLATE_ID) forbidden("Default template cannot be edited");
    if (!isValidId(id)) invalidId("Invalid template id");

    const doc = await WorkshopTemplate.findById(id);
    if (!doc) notFound("Template not found");
    if (String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    if (req.body.title !== undefined) doc.title = String(req.body.title || "").trim().slice(0, 80);
    if (req.body.summary !== undefined) doc.summary = String(req.body.summary || "").trim().slice(0, 300);
    if (req.body.previewImageUrl !== undefined) doc.previewImageUrl = String(req.body.previewImageUrl || "").trim().slice(0, 1000);
    if (req.body.tags !== undefined) doc.tags = toTags(req.body.tags);
    if (req.body.shared !== undefined) doc.shared = Boolean(req.body.shared);
    if (req.body.theme !== undefined) doc.theme = normalizeTheme(req.body.theme);
    if (req.body.layout !== undefined) doc.layout = normalizeLayout(req.body.layout);
    if (req.body.siteDraft !== undefined) doc.siteDraft = normalizeSiteDraft(req.body.siteDraft);

    const changeSummary = String(req.body.changeSummary || "").trim().slice(0, 300);
    const changeSource = req.body.changeSource === "ai" ? "ai" : "manual";
    if (doc.isModified()) {
      doc.updateLogs = [
        createUpdateLogEntry({
          title: changeSource === "ai" ? "AI-assisted update" : "Template updated",
          summary: changeSummary || "Adjusted template style, structure or layout.",
          authorName: req.user.username,
          source: changeSource,
        }),
        ...(Array.isArray(doc.updateLogs) ? doc.updateLogs : []),
      ].slice(0, 40);
    }

    await doc.save();
    const populated = await WorkshopTemplate.findById(doc._id).populate("author", "_id username role").lean();
    res.json({ ok: true, template: toTemplatePayload(populated) });
  } catch (err) {
    next(err);
  }
}

async function previewAiEdit(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const instruction = String(req.body.instruction || "").trim();
    if (!instruction) badRequest("Instruction is required");

    const draft = normalizeDraftPayload(req.body.draft);
    const history = Array.isArray(req.body.history)
      ? req.body.history
          .map((item) => ({ role: item?.role, content: String(item?.content || "").slice(0, 400) }))
          .filter((item) => item.role === "user" || item.role === "assistant")
      : [];

    const aiResult = await generateWorkshopEditPlan({ instruction, history, draft });
    const changes = aiResult.changes && typeof aiResult.changes === "object" ? aiResult.changes : {};

    const nextDraft = {
      title: changes.title !== undefined ? String(changes.title || "").trim().slice(0, 80) : draft.title,
      summary: changes.summary !== undefined ? String(changes.summary || "").trim().slice(0, 300) : draft.summary,
      tags: changes.tags !== undefined ? toTags(changes.tags) : draft.tags,
      theme: changes.theme !== undefined
        ? normalizeTheme({
            ...draft.theme,
            ...changes.theme,
            componentCss: { ...draft.theme.componentCss, ...(changes.theme?.componentCss || {}) },
          })
        : draft.theme,
      layout: changes.layout ? mergeLayout(draft.layout, changes.layout) : draft.layout,
    };

    res.json({
      ok: true,
      assistantMessage: String(aiResult.assistantMessage || "已生成新的安全改版草案。").slice(0, 500),
      draft: nextDraft,
      model: aiResult.model,
    });
  } catch (err) {
    next(err);
  }
}

async function listTemplateComments(req, res, next) {
  try {
    const { id } = req.params;
    await assertTemplateReadable(id, req.user);
    const comments = await WorkshopTemplateComment.find({ templateId: id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("author", "_id username role")
      .lean();
    res.json({ ok: true, comments });
  } catch (err) {
    next(err);
  }
}

async function addTemplateComment(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const { id } = req.params;
    await assertTemplateReadable(id, req.user);

    const content = String(req.body.content || "").trim();
    if (!content) badRequest("Comment content is required");

    const comment = await WorkshopTemplateComment.create({
      templateId: id,
      author: req.user._id,
      content: content.slice(0, 1000),
    });

    if (id !== DEFAULT_TEMPLATE_ID) {
      await WorkshopTemplate.updateOne({ _id: id }, { $inc: { "stats.commentCount": 1 } });
    }

    const populated = await WorkshopTemplateComment.findById(comment._id)
      .populate("author", "_id username role")
      .lean();
    res.status(201).json({ ok: true, comment: populated });
  } catch (err) {
    next(err);
  }
}

async function toggleTemplateLike(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const { id } = req.params;
    if (id === DEFAULT_TEMPLATE_ID) {
      return res.json({ ok: true, liked: false, likeCount: 0 });
    }
    if (!isValidId(id)) invalidId("Invalid template id");

    const exists = await WorkshopTemplateLike.findOne({ user: req.user._id, template: id });
    let liked = false;
    if (exists) {
      await WorkshopTemplateLike.deleteOne({ _id: exists._id });
      liked = false;
    } else {
      await WorkshopTemplateLike.create({ user: req.user._id, template: id });
      liked = true;
    }

    const likeCount = await WorkshopTemplateLike.countDocuments({ template: id });
    await WorkshopTemplate.updateOne({ _id: id }, { $set: { "stats.likeCount": likeCount } });

    res.json({ ok: true, liked, likeCount });
  } catch (err) {
    next(err);
  }
}

async function toggleTemplateBookmark(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const { id } = req.params;
    if (id === DEFAULT_TEMPLATE_ID) {
      return res.json({ ok: true, bookmarked: false, bookmarkCount: 0 });
    }
    if (!isValidId(id)) invalidId("Invalid template id");

    const exists = await WorkshopTemplateBookmark.findOne({ user: req.user._id, template: id });
    let bookmarked = false;
    if (exists) {
      await WorkshopTemplateBookmark.deleteOne({ _id: exists._id });
      bookmarked = false;
    } else {
      await WorkshopTemplateBookmark.create({ user: req.user._id, template: id });
      bookmarked = true;
    }

    const bookmarkCount = await WorkshopTemplateBookmark.countDocuments({ template: id });
    await WorkshopTemplate.updateOne({ _id: id }, { $set: { "stats.bookmarkCount": bookmarkCount } });

    res.json({ ok: true, bookmarked, bookmarkCount });
  } catch (err) {
    next(err);
  }
}

async function applyTemplate(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const { id } = req.params;
    if (id === DEFAULT_TEMPLATE_ID) {
      await User.updateOne({ _id: req.user._id }, { $set: { activeWorkshopTemplate: null } });
      return res.json({ ok: true, activeTemplate: buildDefaultTemplatePayload() });
    }
    if (!isValidId(id)) invalidId("Invalid template id");

    const doc = await WorkshopTemplate.findById(id).lean();
    if (!doc) notFound("Template not found");
    if (!doc.shared && String(doc.author) !== String(req.user._id)) forbidden("Forbidden");

    await Promise.all([
      User.updateOne({ _id: req.user._id }, { $set: { activeWorkshopTemplate: id } }),
      WorkshopTemplate.updateOne({ _id: id }, { $inc: { appliedCount: 1 } }),
    ]);

    const template = await WorkshopTemplate.findById(id).populate("author", "_id username role").lean();
    res.json({ ok: true, activeTemplate: toTemplatePayload(template) });
  } catch (err) {
    next(err);
  }
}

async function getActiveTemplate(req, res, next) {
  try {
    if (!req.user) unauthorized("Login required");
    const me = await User.findById(req.user._id).select("activeWorkshopTemplate").lean();
    const templateId = me?.activeWorkshopTemplate;
    if (!templateId) {
      return res.json({ ok: true, activeTemplate: buildDefaultTemplatePayload() });
    }

    const template = await WorkshopTemplate.findById(templateId).populate("author", "_id username role").lean();
    if (!template) {
      return res.json({ ok: true, activeTemplate: buildDefaultTemplatePayload() });
    }

    res.json({ ok: true, activeTemplate: toTemplatePayload(template) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listTemplates,
  listMyTemplates,
  listTemplateTagInsights,
  getTemplateDetail,
  createTemplate,
  updateTemplate,
  previewAiEdit,
  listTemplateComments,
  addTemplateComment,
  toggleTemplateLike,
  toggleTemplateBookmark,
  applyTemplate,
  getActiveTemplate,
};