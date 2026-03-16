const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Idea = require("../models/Idea");
const Like = require("../models/Like");
const Bookmark = require("../models/Bookmark");
const Notification = require("../models/Notification");
const { canReadIdea, canWriteIdea } = require("../utils/permissions");
const { invalidId, notFound, unauthorized, forbidden } = require("../utils/http");
const { parseMentions } = require("../utils/mentionParser");
const { validateFeedback } = require("../services/aiReview.service");
const AppError = require("../utils/AppError");
const errorCodes = require("../utils/errorCodes");
const IdeaRecommendationFeedback = require("../models/IdeaRecommendationFeedback");


require("../models/User"); // 确保 populate(User) 不报错
// IdeaView 用于记录用户对某个 idea 的最后浏览时间（用于每天只计一次 view）
const IdeaView = require("../models/IdeaView");

function toStringArray(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String).map(s => s.trim()).filter(Boolean);
  return String(tags)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function normalizeImageUrls(input, limit = 8) {
  if (!input || !Array.isArray(input)) return [];
  return input
    .map((item) => String(item || "").trim())
    .filter((item) => item && /^https?:\/\//i.test(item))
    .slice(0, limit);
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchTokens(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((item) => String(item || "").trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, 20);
  }

  return [...new Set(
    String(raw || "")
      .split(/[#,，,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 20);
}

function getIdeaHotScore(idea) {
  const stats = idea?.stats || {};
  const likeCount = Number(stats.likeCount || 0);
  const commentCount = Number(stats.commentCount || 0);
  const bookmarkCount = Number(stats.bookmarkCount || 0);
  const viewCount = Number(stats.viewCount || 0);
  return likeCount * 6 + commentCount * 4 + bookmarkCount * 3 + Math.min(viewCount, 5000) * 0.04;
}

function getIdeaRecencyScore(idea) {
  const createdAt = new Date(idea?.createdAt || 0).getTime() || 0;
  const ageDays = Math.max((Date.now() - createdAt) / (24 * 60 * 60 * 1000), 0);
  return Math.max(0, 30 - ageDays * 0.8);
}

function getColdStartRecommendationScore(idea) {
  const hotScore = getIdeaHotScore(idea);
  const recencyScore = getIdeaRecencyScore(idea);
  const ageDays = Math.max((Date.now() - (new Date(idea?.createdAt || 0).getTime() || 0)) / (24 * 60 * 60 * 1000), 0);

  let recentBoost = 0;
  if (ageDays <= 3) recentBoost = 28;
  else if (ageDays <= 7) recentBoost = 20;
  else if (ageDays <= 14) recentBoost = 12;
  else if (ageDays <= 30) recentBoost = 6;

  return hotScore * 0.78 + recencyScore * 0.9 + recentBoost;
}

function scoreIdeaAgainstTokens(idea, tokens) {
  const ideaTags = Array.isArray(idea?.tags) ? idea.tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean) : [];
  const title = String(idea?.title || "").toLowerCase();
  const summary = String(idea?.summary || "").toLowerCase();
  const content = String(idea?.content || "").toLowerCase();
  const platform = String(idea?.externalSource?.platform || "").toLowerCase();

  let matchedTokenCount = 0;
  let matchedTagCount = 0;
  let score = 0;

  for (const token of tokens) {
    let tokenMatched = false;

    if (ideaTags.some((tag) => tag === token)) {
      score += 18;
      matchedTagCount += 1;
      tokenMatched = true;
    } else if (ideaTags.some((tag) => tag.includes(token) || token.includes(tag))) {
      score += 10;
      matchedTagCount += 1;
      tokenMatched = true;
    }

    if (title.includes(token)) {
      score += 8;
      tokenMatched = true;
    }
    if (summary.includes(token)) {
      score += 4;
      tokenMatched = true;
    }
    if (content.includes(token)) {
      score += 3;
      tokenMatched = true;
    }
    if (platform.includes(token)) {
      score += 5;
      tokenMatched = true;
    }

    if (tokenMatched) matchedTokenCount += 1;
  }

  return {
    matchedTokenCount,
    matchedTagCount,
    score,
  };
}

function sortIdeasByScore(items) {
  return items.sort((a, b) => {
    if (b._rankScore !== a._rankScore) return b._rankScore - a._rankScore;
    if ((b._matchedTokenCount || 0) !== (a._matchedTokenCount || 0)) return (b._matchedTokenCount || 0) - (a._matchedTokenCount || 0);
    if ((b._matchedTagCount || 0) !== (a._matchedTagCount || 0)) return (b._matchedTagCount || 0) - (a._matchedTagCount || 0);
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
}

function getViewedPenalty(lastViewedAt) {
  if (!lastViewedAt) return 0;
  const viewedAt = new Date(lastViewedAt).getTime() || 0;
  const ageDays = Math.max((Date.now() - viewedAt) / (24 * 60 * 60 * 1000), 0);
  if (ageDays <= 1) return 55;
  if (ageDays <= 3) return 35;
  if (ageDays <= 7) return 20;
  if (ageDays <= 30) return 8;
  return 3;
}

function getFeedbackPenalty(reason) {
  if (reason === "already_recommended") return 38;
  return 0;
}

const IDEA_TYPES = new Set(["business", "feedback", "external", "daily"]);

function normalizeIdeaType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!IDEA_TYPES.has(value)) return null;
  return value;
}

function inferIdeaType(idea) {
  const normalized = normalizeIdeaType(idea?.ideaType);

  if (normalized === "feedback" || idea?.isFeedback) return "feedback";

  const platform = String(idea?.externalSource?.platform || "").trim();
  const sourceUrl = String(idea?.externalSource?.url || "").trim();
  if (platform || sourceUrl) return "external";

  if (normalized) return normalized;

  // Legacy items without explicit type are treated as daily ideas.
  return "daily";
}

function normalizeHttpUrl(raw) {
  const val = String(raw || "").trim();
  if (!val) return "";
  if (/^http:\/\//i.test(val)) return val.replace(/^http:\/\//i, "https://");
  if (/^https:\/\//i.test(val)) return val;
  if (val.startsWith("//")) return `https:${val}`;
  return "";
}

function extractBilibiliVideoIdFromUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host.includes("bilibili.com") && !host.includes("b23.tv")) return null;

    const path = String(parsed.pathname || "");
    const bvidMatch = path.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (bvidMatch?.[1]) return { bvid: bvidMatch[1] };

    const aidMatch = path.match(/\/video\/av(\d+)/i);
    if (aidMatch?.[1]) return { aid: aidMatch[1] };

    return null;
  } catch {
    return null;
  }
}

async function resolveBilibiliCover(rawUrl) {
  const id = extractBilibiliVideoIdFromUrl(rawUrl);
  if (!id) return "";

  const axios = (await import("axios")).default;
  const apiRes = await axios.get("https://api.bilibili.com/x/web-interface/view", {
    params: id,
    timeout: 12000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: "https://www.bilibili.com/",
    },
  });

  return normalizeHttpUrl(apiRes?.data?.data?.pic);
}

function isHotlinkProneCoverUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    return host.includes("hdslb.com") || host.includes("bilibili.com");
  } catch {
    return false;
  }
}

function buildRequestBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || req.protocol;
  const host = req.get("host");
  return `${protocol}://${host}`;
}

async function saveRemoteImageToLocal(sourceUrl, publicBaseUrl) {
  const normalizedSourceUrl = normalizeHttpUrl(sourceUrl);
  if (!normalizedSourceUrl) return "";

  const parsed = new URL(normalizedSourceUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) return "";

  const axios = (await import("axios")).default;
  const response = await axios.get(normalizedSourceUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: `${parsed.protocol}//${parsed.host}/`,
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("image/")) return "";

  const bytes = Buffer.from(response.data);
  const MAX_BYTES = 5 * 1024 * 1024;
  if (bytes.length > MAX_BYTES) return "";

  // 上传到 Cloudinary
  const { uploadToCloudinary } = require('../middleware/upload');
  const cloudinaryUrl = await uploadToCloudinary(
    bytes,
    'cover-images',
    `scraped-${Date.now()}`
  );

  return cloudinaryUrl;
}

function validateExternalSource(externalSource) {
  if (!externalSource) return null;
  
  const { platform, url, originalAuthor, sourceCreatedAt } = externalSource;
  
  // If platform is provided, url is required
  if (platform && !platform.trim()) {
    throw new AppError({
      code: "INVALID_EXTERNAL_SOURCE",
      status: 400,
      message: "Platform name is required for external source."
    });
  }
  
  if (platform && !url) {
    throw new AppError({
      code: "INVALID_EXTERNAL_SOURCE",
      status: 400,
      message: "URL is required for external source."
    });
  }
  
  if (platform && !isValidUrl(url)) {
    throw new AppError({
      code: "INVALID_EXTERNAL_SOURCE",
      status: 400,
      message: "Invalid URL format."
    });
  }
  
  return {
    platform: platform ? String(platform).trim() : undefined,
    url: url ? String(url).trim() : undefined,
    originalAuthor: originalAuthor ? String(originalAuthor).trim() : undefined,
    sourceCreatedAt: sourceCreatedAt ? new Date(sourceCreatedAt) : undefined,
  };
}

/**
 * POST /api/ideas
 * 需要登录：req.user
 * body: title, summary, content, tags, visibility, isMonetizable, licenseType
 */
async function createIdea(req, res, next) {
  try {
    const { ideaType, title, summary, content, imageUrls, coverImageUrl, visibility, isMonetizable, licenseType, tags, isFeedback, externalSource } = req.body;

    if (!title || !title.trim()) {
      invalidId("Invalid idea id")
    }

    // Enforce: clients should not create server-side private ideas — private ideas are stored locally in browser.
    if (visibility === "private") {
      // tell client to save locally instead of creating on server
      return res.status(400).json({ ok: false, code: "PRIVATE_SAVE_LOCAL", message: "Private ideas should be saved locally in browser." });
    }

    // Enforce public idea limit for free users
    const PUBLIC_LIMIT = Number(process.env.FREE_PUBLIC_IDEA_LIMIT || 5);
    if ((visibility || "public") === "public" && req.user) {
      const role = (req.user && req.user.role) || "user";
      if (role !== "company" && role !== "admin") {
        const count = await Idea.countDocuments({ author: req.user._id, visibility: "public" });
        if (count >= PUBLIC_LIMIT) {
          const { publicLimitExceeded } = require("../utils/http");
          return next(new (require("../utils/AppError"))({ code: require("../utils/errorCodes").PUBLIC_LIMIT_EXCEEDED, status: 403, message: `Free accounts can publish up to ${PUBLIC_LIMIT} public ideas.`, details: { limit: PUBLIC_LIMIT } }));
        }
      }
    }

    // Validate feedback if isFeedback is true
    let feedbackType = null;
    let feedbackStatus = null;
    let aiSummary = "";
    let feedbackTags = toStringArray(tags);

    if (isFeedback) {
      const validation = await validateFeedback({ title, summary, content });
      
      if (!validation.isValid) {
        throw new AppError({
          code: errorCodes.FEEDBACK_VALIDATION_FAILED,
          status: 400,
          message: validation.reason || "反馈内容无效，请提供有意义的bug报告或功能建议。",
        });
      }

      feedbackType = validation.feedbackType;
      feedbackStatus = "pending";
      aiSummary = validation.summary;

      // Add appropriate feedback tag
      const feedbackTag = feedbackType === "bug" ? "bug" : "网站建议";
      if (!feedbackTags.includes(feedbackTag)) {
        feedbackTags.push(feedbackTag);
      }
    }

    // Parse mentions from content to build invited users list
    const { userIds: mentionedUserIds } = await parseMentions(content);

    // Validate external source if provided
    const validatedExternalSource = validateExternalSource(externalSource);

    let normalizedIdeaType = normalizeIdeaType(ideaType);
    if (!normalizedIdeaType) {
      normalizedIdeaType = Boolean(isFeedback)
        ? "feedback"
        : validatedExternalSource
          ? "external"
          : "daily";
    }

    const idea = await Idea.create({
      ideaType: normalizedIdeaType,
      title: title.trim(),
      summary: summary || "",
      content: content || "",
      imageUrls: normalizeImageUrls(imageUrls),
      coverImageUrl: /^https?:\/\//i.test(String(coverImageUrl || "").trim()) ? String(coverImageUrl).trim() : "",
      author: req.user._id,
      tags: feedbackTags,
      visibility: visibility || "public",
      isMonetizable: Boolean(isMonetizable),
      licenseType: licenseType || "default",
      invitedUsers: mentionedUserIds,
      isFeedback: Boolean(isFeedback),
      feedbackType,
      feedbackStatus,
      aiSummary,
      externalSource: validatedExternalSource,
    });

    // Create INVITE notifications for mentioned users
    if (mentionedUserIds.length > 0) {
      const notifs = mentionedUserIds.map(userId => ({
        userId,
        actorId: req.user._id,
        ideaId: idea._id,
        type: "INVITE",
        payload: { title: idea.title },
      }));
      await Notification.insertMany(notifs);
    }

    const populated = await Idea.findById(idea._id).populate("author", "_id username role");
    res.status(201).json({ ok: true, idea: populated });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ideas?page=1&limit=20&sort=recommended|new|hot
 * Phase 3：列表只返回 public（unlisted/private 不出现在列表）
 * sort:
 *  - recommended: recent search tag affinity + engagement + recency
 *  - new: createdAt desc
 *  - hot: stats.likeCount desc, then comment/view counts, then createdAt desc
 */
async function listIdeas(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 50);

    const sort = String(req.query.sort || "recommended");
    const sortSpec =
      sort === "hot"
        ? { "stats.likeCount": -1, "stats.commentCount": -1, "stats.viewCount": -1, createdAt: -1 }
        : { createdAt: -1 };

    const q = (req.query.q || req.query.keyword || req.query.tag || "").toString().trim();
    const queryTokens = normalizeSearchTokens(q);
    const recentSearchTokens = normalizeSearchTokens(req.query.recentTags || "");
    const useScoredRanking = queryTokens.length > 0 || sort === "recommended";
    const requestedIdeaType = normalizeIdeaType(req.query.ideaType);

    // 列表：只返回 public
    const filter = { visibility: "public" };

    let items = [];
    let total = 0;

    if (useScoredRanking) {
      const allPublicIdeas = await Idea.find(filter)
        .populate("author", "_id username role")
        .lean();

      let viewMap = new Map();
      let feedbackMap = new Map();

      if (req.user && allPublicIdeas.length > 0) {
        const ideaIds = allPublicIdeas.map((item) => item._id);
        const [views, feedbacks] = await Promise.all([
          IdeaView.find({ user: req.user._id, idea: { $in: ideaIds } })
            .select("idea lastViewedAt")
            .lean(),
          IdeaRecommendationFeedback.find({ user: req.user._id, idea: { $in: ideaIds } })
            .select("idea reason")
            .lean(),
        ]);

        viewMap = new Map(views.map((item) => [String(item.idea), item.lastViewedAt]));
        feedbackMap = new Map(feedbacks.map((item) => [String(item.idea), item.reason]));
      }

      const ranked = allPublicIdeas
        .map((item) => {
          if (requestedIdeaType && inferIdeaType(item) !== requestedIdeaType) {
            return null;
          }

          const itemId = String(item._id);
          const hotScore = getIdeaHotScore(item);
          const recencyScore = getIdeaRecencyScore(item);
          const feedbackReason = feedbackMap.get(itemId) || null;
          const viewedPenalty = getViewedPenalty(viewMap.get(itemId));

          if (sort === "recommended" && queryTokens.length === 0 && feedbackReason === "not_interested") {
            return null;
          }

          if (queryTokens.length > 0) {
            const relevance = scoreIdeaAgainstTokens(item, queryTokens);
            if (relevance.matchedTokenCount === 0) return null;
            return {
              ...item,
              recommendationFeedbackReason: feedbackReason,
              _matchedTokenCount: relevance.matchedTokenCount,
              _matchedTagCount: relevance.matchedTagCount,
              _rankScore: relevance.score + hotScore * 0.55 + recencyScore * 0.35,
            };
          }

          const preference = recentSearchTokens.length > 0
            ? scoreIdeaAgainstTokens(item, recentSearchTokens)
            : { matchedTokenCount: 0, matchedTagCount: 0, score: 0 };

          const coldStartScore = recentSearchTokens.length === 0
            ? getColdStartRecommendationScore(item)
            : 0;

          return {
            ...item,
            recommendationFeedbackReason: feedbackReason,
            _matchedTokenCount: preference.matchedTokenCount,
            _matchedTagCount: preference.matchedTagCount,
            _rankScore:
              recentSearchTokens.length > 0
                ? preference.score * 1.2 + hotScore * 0.45 + recencyScore * 0.3 - viewedPenalty - getFeedbackPenalty(feedbackReason)
                : coldStartScore - viewedPenalty - getFeedbackPenalty(feedbackReason),
          };
        })
        .filter(Boolean);

      sortIdeasByScore(ranked);
      total = ranked.length;
      items = ranked.slice((page - 1) * limit, page * limit);
    } else {
      let findFilter = filter;
      if (requestedIdeaType === "external") {
        findFilter = {
          ...filter,
          $or: [
            { ideaType: "external" },
            { "externalSource.url": { $exists: true, $nin: [null, ""] } },
            { "externalSource.platform": { $exists: true, $nin: [null, ""] } },
          ],
        };
      } else if (requestedIdeaType) {
        findFilter = { ...filter, ideaType: requestedIdeaType };
      }

      [items, total] = await Promise.all([
        Idea.find(findFilter)
          .sort(sortSpec)
          .skip((page - 1) * limit)
          .limit(limit)
          .populate("author", "_id username role")
          .lean(),
        Idea.countDocuments(findFilter),
      ]);

      // For legacy ideas that were created before ideaType existed, keep them visible in daily/feedback/external views.
      if (requestedIdeaType && (requestedIdeaType === "daily" || requestedIdeaType === "feedback" || requestedIdeaType === "external")) {
        const legacyCandidates = await Idea.find({ visibility: "public", ideaType: { $exists: false } })
          .sort(sortSpec)
          .populate("author", "_id username role")
          .lean();

        const legacyMatched = legacyCandidates.filter((item) => inferIdeaType(item) === requestedIdeaType);
        if (legacyMatched.length > 0) {
          const merged = [...items, ...legacyMatched]
            .sort((a, b) => {
              if (sort === "hot") {
                const ah = Number(a?.stats?.likeCount || 0) * 1000000 + Number(a?.stats?.commentCount || 0) * 1000 + Number(a?.stats?.viewCount || 0);
                const bh = Number(b?.stats?.likeCount || 0) * 1000000 + Number(b?.stats?.commentCount || 0) * 1000 + Number(b?.stats?.viewCount || 0);
                if (bh !== ah) return bh - ah;
              }
              return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
            });

          total = merged.length;
          items = merged.slice((page - 1) * limit, page * limit);
        }
      }
    }

    // Best-effort backfill/localization for old BiliBili items.
    const backfillCoverItems = items.filter((item) => {
      const currentCover = String(item.coverImageUrl || "").trim();
      const hasExternalSourceUrl = Boolean(item?.externalSource?.url);
      return (hasExternalSourceUrl && !currentCover) || isHotlinkProneCoverUrl(currentCover);
    });

    if (backfillCoverItems.length > 0) {
      const requestBaseUrl = buildRequestBaseUrl(req);
      const publicBaseUrl = process.env.API_URL || requestBaseUrl;

      await Promise.all(
        backfillCoverItems.slice(0, 6).map(async (item) => {
          try {
            const existingCover = normalizeHttpUrl(item.coverImageUrl);
            const resolvedCover = existingCover || await resolveBilibiliCover(item.externalSource?.url);
            if (!resolvedCover) return;

            const localizedCover = await saveRemoteImageToLocal(resolvedCover, publicBaseUrl).catch(() => "");
            const finalCover = localizedCover || resolvedCover;

            if (!finalCover || finalCover === item.coverImageUrl) return;
            item.coverImageUrl = finalCover;

            await Idea.updateOne(
              { _id: item._id },
              { $set: { coverImageUrl: finalCover } }
            );
          } catch {
            // Ignore backfill failures to avoid impacting list API stability.
          }
        })
      );
    }

    const totalPages = Math.max(Math.ceil(total / limit), 1);

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages,
      ideas: items.map((item) => {
        if (!item || typeof item !== "object") return item;
        const { _rankScore, _matchedTokenCount, _matchedTagCount, ...rest } = item;
        return rest;
      }),
    });
  } catch (err) {
    next(err);
  }
}

async function submitRecommendationFeedback(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id");
    }

    const idea = await Idea.findById(id).select("_id visibility").lean();
    if (!idea) {
      notFound("Idea not found");
    }

    if (idea.visibility !== "public") {
      forbidden("Forbidden");
    }

    const { reason } = req.body;
    const feedback = await IdeaRecommendationFeedback.findOneAndUpdate(
      { user: req.user._id, idea: id },
      { $set: { reason } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    res.json({ ok: true, feedback });
  } catch (err) {
    next(err);
  }
}

async function clearRecommendationFeedback(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id");
    }

    await IdeaRecommendationFeedback.deleteOne({ user: req.user._id, idea: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}


/**
 * GET /api/ideas/:id
 * 可见性规则：
 *  - public: anyone
 *  - unlisted: anyone with id
 *  - private: only author (must be logged in)
 * 额外：访问一次 viewCount + 1
 */
async function getIdeaById(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id")
    }

    const idea = await Idea.findById(id).populate("author", "_id username role");
    if (!idea) {
      notFound("Idea not found")
    }

    // 权限判断
    if (!canReadIdea(idea, req.user)) {
      // private 且未登录 → 401 更合理；private 且登录但不是作者 → 403
      if (!req.user) {
        unauthorized("Login required")
      }
      forbidden("Forbidden")
    }


    // 只有已登录用户会计入 view；且同一用户在 24 小时内仅计一次
    if (req.user) {
      try {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const now = new Date();

        const existing = await IdeaView.findOne({ user: req.user._id, idea: idea._id });
        if (!existing) {
          // 首次浏览：创建记录并 +1
          await IdeaView.create({ user: req.user._id, idea: idea._id, lastViewedAt: now });
          idea.stats = idea.stats || {};
          idea.stats.viewCount = (idea.stats.viewCount || 0) + 1;
          await idea.save();
        } else {
          const last = existing.lastViewedAt || existing.createdAt || new Date(0);
          if (now.getTime() - new Date(last).getTime() >= DAY_MS) {
            existing.lastViewedAt = now;
            await existing.save();
            idea.stats = idea.stats || {};
            idea.stats.viewCount = (idea.stats.viewCount || 0) + 1;
            await idea.save();
          }
        }
      } catch (e) {
        // 任何计数错误不应阻塞返回（例如并发或索引冲突），只打印日志
        console.error("view count update failed:", e?.message || e);
      }
    }

    let liked = false;
    let bookmarked = false;

    if (req.user) {
      const [l, b] = await Promise.all([
        Like.findOne({ user: req.user._id, idea: idea._id }).lean(),
        Bookmark.findOne({ user: req.user._id, idea: idea._id, type: "idea" }).lean(),
      ]);
      liked = !!l;
      bookmarked = !!b;
    }

    res.json({ ok: true, idea, liked, bookmarked });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/ideas/:id
 * 仅作者可改
 * 允许更新：title, summary, content, tags, visibility, isMonetizable, licenseType
 */
async function updateIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      invalidId("Invalid idea id")
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found")
    }

    if (!canWriteIdea(idea, req.user)) {
      forbidden("Forbidden")
    }


    const { ideaType, title, summary, content, imageUrls, tags, visibility, isMonetizable, licenseType } = req.body;

    if (title !== undefined) {
      if (!String(title).trim()) {
        res.status(400);
        throw new Error("title cannot be empty");
      }
      idea.title = String(title).trim();
    }
    if (summary !== undefined) idea.summary = String(summary);
    
    if (content !== undefined) {
      idea.content = String(content);
      // Re-parse mentions when content changes
      const { userIds: mentionedUserIds } = await parseMentions(content);
      // Find new mentions (not already in invitedUsers)
      const currentInvited = idea.invitedUsers.map(u => String(u));
      const newMentions = mentionedUserIds.filter(uid => !currentInvited.includes(String(uid)));
      
      // Add new mentioned users
      if (newMentions.length > 0) {
        idea.invitedUsers = [...new Set([...currentInvited.map(u => new mongoose.Types.ObjectId(u)), ...newMentions])];
        // Create INVITE notifications for newly mentioned users
        const notifs = newMentions.map(userId => ({
          userId,
          actorId: req.user._id,
          ideaId: idea._id,
          type: "INVITE",
          payload: { title: idea.title },
        }));
        await Notification.insertMany(notifs);
      }
    }
    
    if (tags !== undefined) idea.tags = toStringArray(tags);
    if (imageUrls !== undefined) idea.imageUrls = normalizeImageUrls(imageUrls);
    if (visibility !== undefined) idea.visibility = visibility;
    if (isMonetizable !== undefined) idea.isMonetizable = Boolean(isMonetizable);
    if (licenseType !== undefined) idea.licenseType = String(licenseType);
    if (ideaType !== undefined) {
      const normalizedIdeaType = normalizeIdeaType(ideaType);
      if (normalizedIdeaType) idea.ideaType = normalizedIdeaType;
    }
    if (req.body.externalSource !== undefined) {
      idea.externalSource = validateExternalSource(req.body.externalSource);
    }

    await idea.save();

    const populated = await Idea.findById(id).populate("author", "_id username role");
    res.json({ ok: true, idea: populated });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/ideas/:id
 * 仅作者可删
 */
async function deleteIdea(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) {
      badRequest("title is required");
    }

    const idea = await Idea.findById(id);
    if (!idea) {
      notFound("Idea not found");
    }

    if (!canWriteIdea(idea, req.user)) {
      forbidden("Forbidden")
    }


    await Idea.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function listMyIdeas(req, res, next) {
  try {
    const items = await Idea.find({ author: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("author", "_id username role");
    res.json({ ok: true, ideas: items });
  } catch (err) {
    next(err);
  }
}

// suggestion endpoint for idea titles (used by client autocomplete)
async function suggestTitles(req, res, next) {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.json({ ok: true, ideas: [] });
    const re = new RegExp(q.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "i");
    const items = await Idea.find({ visibility: "public", title: re })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("title")
      .lean();
    res.json({ ok: true, ideas: items.map(i => ({ id: i._id, title: i.title })) });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createIdea,
  listIdeas,
  getIdeaById,
  updateIdea,
  deleteIdea,
  listMyIdeas,
  suggestTitles,
  submitRecommendationFeedback,
  clearRecommendationFeedback,
};
