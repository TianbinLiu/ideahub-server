/**
 * Scraper Controller
 * Fetches content from external URLs for creating ideas from external sources
 */

const AppError = require("../utils/AppError");
const Idea = require("../models/Idea");
const ScraperJob = require("../models/ScraperJob");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PLATFORM_CATALOG = [
  {
    id: "bilibili",
    name: "BiliBili",
    type: "video",
    supportsViewThreshold: true,
    status: "ready",
  },
];

function normalizeKeywordList(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 20);
  }

  return [...new Set(
    String(raw || "")
      .split(/[\n,，|]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  )].slice(0, 20);
}

function stripHtml(input) {
  return String(input || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPlatformName(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host.includes("bilibili.com") || host.includes("b23.tv")) return "BiliBili";
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
  if (host.includes("facebook.com")) return "Facebook";
  if (host.includes("twitter.com") || host.includes("x.com")) return "Twitter";
  if (host.includes("instagram.com")) return "Instagram";
  if (host.includes("tiktok.com")) return "TikTok";
  if (host.includes("weibo.com")) return "微博";
  return "";
}

function normalizeHttpUrl(raw) {
  const val = String(raw || "").trim();
  if (!val) return "";
  if (/^http:\/\//i.test(val)) return val.replace(/^http:\/\//i, "https://");
  if (/^https:\/\//i.test(val)) return val;
  if (val.startsWith("//")) return `https:${val}`;
  return "";
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

async function importCoverImage(req, res, next) {
  try {
    const sourceUrl = normalizeHttpUrl(req.body?.url);
    if (!sourceUrl) {
      throw new AppError({ code: "INVALID_URL", status: 400, message: "Valid HTTP/HTTPS image URL is required" });
    }

    const requestBaseUrl = buildRequestBaseUrl(req);
    const baseUrl = process.env.API_URL || requestBaseUrl;
    const imageUrl = await saveRemoteImageToLocal(sourceUrl, baseUrl);
    if (!imageUrl) {
      throw new AppError({ code: "INVALID_IMAGE", status: 400, message: "Source URL is not a supported image or exceeds limit" });
    }

    res.json({ ok: true, imageUrl });
  } catch (err) {
    next(err);
  }
}

function isVideoPlatformVideoUrl(parsedUrl) {
  const host = String(parsedUrl?.hostname || "").toLowerCase();
  const path = String(parsedUrl?.pathname || "").toLowerCase();
  if (!host) return false;

  if ((host.includes("bilibili.com") || host.includes("b23.tv")) && path.includes("/video/")) return true;
  if ((host.includes("youtube.com") && (path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/"))) || host.includes("youtu.be")) return true;
  if (host.includes("tiktok.com") && path.includes("/video/")) return true;
  if (host.includes("vimeo.com")) return true;
  return false;
}

function extractBilibiliVideoId(parsedUrl) {
  const host = String(parsedUrl?.hostname || "").toLowerCase();
  if (!host.includes("bilibili.com") && !host.includes("b23.tv")) return null;

  const path = String(parsedUrl?.pathname || "");
  const bvidMatch = path.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  if (bvidMatch?.[1]) return { bvid: bvidMatch[1] };

  const aidMatch = path.match(/\/video\/av(\d+)/i);
  if (aidMatch?.[1]) return { aid: aidMatch[1] };

  return null;
}

function parseViewCount(raw) {
  if (typeof raw === "number") return raw;
  const text = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/,/g, "");
  if (!text) return 0;

  const value = parseFloat(text.replace(/[^\d.]/g, ""));
  if (Number.isNaN(value)) return 0;

  if (text.includes("亿")) return Math.round(value * 100000000);
  if (text.includes("万")) return Math.round(value * 10000);
  if (text.endsWith("k")) return Math.round(value * 1000);
  if (text.endsWith("m")) return Math.round(value * 1000000);
  if (text.endsWith("b")) return Math.round(value * 1000000000);
  return Math.round(value);
}

function toTagArray(rawPieces) {
  const all = rawPieces
    .filter(Boolean)
    .flatMap((piece) => String(piece).split(/[,，|/、\s]+/))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(all)].slice(0, 8);
}

async function fetchBilibiliCandidates({ keywords, limit, maxPages }) {
  const axios = (await import("axios")).default;
  const safeLimit = Math.min(Math.max(parseInt(limit || "20", 10), 1), 100);
  const safePages = Math.min(Math.max(parseInt(maxPages || "5", 10), 1), 20);
  const candidates = [];
  const seenUrls = new Set();
  const terms = normalizeKeywordList(keywords);
  const effectiveTerms = terms.length > 0 ? terms : ["热门"];

  for (const keyword of effectiveTerms) {
    for (let page = 1; page <= safePages && candidates.length < safeLimit; page += 1) {
      const url = "https://api.bilibili.com/x/web-interface/search/type";
      const res = await axios.get(url, {
        params: {
          search_type: "video",
          keyword,
          page,
          order: "pubdate",
        },
        timeout: 15000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Referer: "https://www.bilibili.com/",
        },
      });

      const items = res?.data?.data?.result || [];
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        const arcUrl = item.arcurl || (item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "");
        if (!arcUrl || seenUrls.has(arcUrl)) continue;

        seenUrls.add(arcUrl);
        candidates.push({
          url: arcUrl,
          title: stripHtml(item.title || "Untitled video"),
          tags: toTagArray([item.tag, item.typename, keyword, "bilibili"]),
          views: parseViewCount(item.play),
          author: stripHtml(item.author || ""),
          coverImageUrl: normalizeHttpUrl(item.pic),
          sourceCreatedAt: item.pubdate ? new Date(item.pubdate * 1000) : undefined,
          summary: stripHtml(item.description || ""),
          keyword,
        });

        if (candidates.length >= safeLimit) break;
      }
    }
  }

  return candidates;
}

async function createIdeasFromCandidates({ candidates, minViews, adminUserId, maxCreate, publicBaseUrl }) {
  const created = [];
  const safeMaxCreate = Math.min(Math.max(parseInt(maxCreate || "20", 10), 1), 100);
  const skipped = {
    belowThreshold: 0,
    existing: 0,
    invalid: 0,
    overCreateLimit: 0,
  };

  for (const item of candidates) {
    if (created.length >= safeMaxCreate) {
      skipped.overCreateLimit += 1;
      continue;
    }

    if (!item.url || !item.title) {
      skipped.invalid += 1;
      continue;
    }

    if ((item.views || 0) < minViews) {
      skipped.belowThreshold += 1;
      continue;
    }

    const exists = await Idea.exists({ "externalSource.url": item.url });
    if (exists) {
      skipped.existing += 1;
      continue;
    }

    const summary =
      item.summary || `Auto imported from BiliBili. Views: ${item.views || 0}. Source author: ${item.author || "unknown"}.`;

    let resolvedCoverImageUrl = normalizeHttpUrl(item.coverImageUrl);
    if (resolvedCoverImageUrl && publicBaseUrl) {
      try {
        const localCover = await saveRemoteImageToLocal(resolvedCoverImageUrl, publicBaseUrl);
        if (localCover) resolvedCoverImageUrl = localCover;
      } catch {
        // keep original normalized URL as fallback
      }
    }

    const idea = await Idea.create({
      title: item.title.slice(0, 120),
      summary: summary.slice(0, 300),
      content: "",
      coverImageUrl: resolvedCoverImageUrl || "",
      author: adminUserId,
      tags: item.tags,
      visibility: "public",
      isMonetizable: false,
      licenseType: "default",
      externalSource: {
        platform: "BiliBili",
        url: item.url,
        originalAuthor: item.author || "",
        sourceCreatedAt: item.sourceCreatedAt,
      },
    });

    created.push({
      _id: idea._id,
      title: idea.title,
      url: item.url,
      views: item.views || 0,
      tags: item.tags,
    });
  }

  return { created, skipped };
}

async function listCrawlerPlatforms(req, res, next) {
  try {
    res.json({ ok: true, platforms: PLATFORM_CATALOG });
  } catch (err) {
    next(err);
  }
}

async function listAdminCrawlHistory(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10), 1), 100);
    const jobs = await ScraperJob.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("triggeredBy", "_id username role")
      .lean();

    res.json({ ok: true, jobs });
  } catch (err) {
    next(err);
  }
}

async function startAdminCrawl(req, res, next) {
  let job = null;
  try {
    console.log('[Admin Crawl] Request received from user:', req.user?._id, 'role:', req.user?.role);
    console.log('[Admin Crawl] Request body:', JSON.stringify(req.body, null, 2));
    
    const platform = String(req.body.platform || "").trim().toLowerCase();
    const minViews = Math.max(parseInt(req.body.minViews || "0", 10) || 0, 0);
    const keywords = normalizeKeywordList(req.body.keywords || req.body.keyword || "热门");
    const limit = Math.min(Math.max(parseInt(req.body.limit || "20", 10), 1), 100);
    const maxPages = Math.min(Math.max(parseInt(req.body.maxPages || "5", 10), 1), 20);
    const maxCreate = Math.min(Math.max(parseInt(req.body.maxCreate || String(limit), 10), 1), 100);

    console.log('[Admin Crawl] Parsed params:', { platform, minViews, keywords, limit, maxPages, maxCreate });

    if (!platform) {
      throw new AppError({ code: "INVALID_PLATFORM", status: 400, message: "platform is required" });
    }

    if (platform !== "bilibili") {
      throw new AppError({ code: "INVALID_PLATFORM", status: 400, message: `Unsupported platform: ${platform}` });
    }

    console.log('[Admin Crawl] Creating scraper job...');
    job = await ScraperJob.create({
      platform,
      triggeredBy: req.user._id,
      status: "running",
      params: {
        keywords,
        minViews,
        limit,
        maxPages,
        maxCreate,
      },
      startedAt: new Date(),
    });
    console.log('[Admin Crawl] Job created:', job._id);

    console.log('[Admin Crawl] Fetching BiliBili candidates...');
    const candidates = await fetchBilibiliCandidates({ keywords, limit, maxPages });
    console.log('[Admin Crawl] Found', candidates.length, 'candidates');
    
    const requestBaseUrl = buildRequestBaseUrl(req);
    const publicBaseUrl = process.env.API_URL || requestBaseUrl;
    
    console.log('[Admin Crawl] Creating ideas from candidates...');
    const { created, skipped } = await createIdeasFromCandidates({
      candidates,
      minViews,
      adminUserId: req.user._id,
      maxCreate,
      publicBaseUrl,
    });
    console.log('[Admin Crawl] Created', created.length, 'ideas');

    const createdIdeaIds = created.map((x) => x._id).filter(Boolean);
    await ScraperJob.findByIdAndUpdate(job._id, {
      $set: {
        status: "success",
        finishedAt: new Date(),
        createdIdeas: createdIdeaIds,
        createdPreview: created.slice(0, 50),
        stats: {
          scanned: candidates.length,
          createdCount: created.length,
          skippedBelowThreshold: skipped.belowThreshold || 0,
          skippedExisting: skipped.existing || 0,
          skippedInvalid: skipped.invalid || 0,
          skippedOverCreateLimit: skipped.overCreateLimit || 0,
        },
      },
    });

    console.log('[Admin Crawl] Job completed successfully');
    res.json({
      ok: true,
      jobId: job._id,
      platform,
      keywords,
      minViews,
      maxPages,
      maxCreate,
      scanned: candidates.length,
      createdCount: created.length,
      skipped,
      created,
    });
  } catch (err) {
    console.error('[Admin Crawl] Error:', err.message);
    console.error('[Admin Crawl] Stack:', err.stack);
    
    if (job?._id) {
      await ScraperJob.findByIdAndUpdate(job._id, {
        $set: {
          status: "failed",
          finishedAt: new Date(),
          errorMessage: String(err?.message || "Unknown crawler error").slice(0, 500),
        },
      }).catch(() => {});
    }
    next(err);
  }
}

/**
 * POST /api/scraper/fetch
 * Fetch title and content from an external URL
 * 
 * Note: This is a basic implementation that works for simple pages.
 * For JavaScript-heavy sites, you may need Puppeteer instead of axios+cheerio.
 */
async function fetchExternalContent(req, res, next) {
  try {
    const { url } = req.body;

    if (!url || typeof url !== "string") {
      throw new AppError({
        code: "INVALID_URL",
        status: 400,
        message: "URL is required",
      });
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      throw new AppError({
        code: "INVALID_URL",
        status: 400,
        message: "Invalid URL format",
      });
    }

    // Security: only allow http/https protocols
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new AppError({
        code: "INVALID_URL",
        status: 400,
        message: "Only HTTP/HTTPS URLs are allowed",
      });
    }

    let title = "";
    let content = "";
    let author = "";
    let platform = detectPlatformName(parsedUrl.hostname);
    let coverImageUrl = "";
    const shouldSuggestCover = isVideoPlatformVideoUrl(parsedUrl);

    // Dynamic import for ESM modules
    const axios = (await import("axios")).default;
    const cheerio = (await import("cheerio")).default;

    // Prefer BiliBili official API for video pages, because HTML may be JS/anti-bot protected.
    const bilibiliId = extractBilibiliVideoId(parsedUrl);
    if (bilibiliId) {
      try {
        // Fetch video info
        const apiRes = await axios.get("https://api.bilibili.com/x/web-interface/view", {
          params: bilibiliId,
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Referer: "https://www.bilibili.com/",
          },
        });

        const data = apiRes?.data?.data;
        if (data?.title) {
          coverImageUrl = normalizeHttpUrl(data?.pic);
          
          // Fetch tags from separate API
          let videoTags = [];
          try {
            const tagRes = await axios.get("https://api.bilibili.com/x/tag/archive/tags", {
              params: bilibiliId,
              timeout: 10000,
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                Referer: "https://www.bilibili.com/",
              },
            });
            
            if (tagRes?.data?.code === 0 && Array.isArray(tagRes.data.data)) {
              videoTags = tagRes.data.data.map(t => t.tag_name).filter(Boolean);
              console.log('[BiliBili Tags API] Successfully fetched tags:', videoTags);
            }
          } catch (tagErr) {
            console.log('[BiliBili Tags API] Failed to fetch tags:', tagErr.message);
          }
          
          const tags = toTagArray([data.tname, ...videoTags, "bilibili"]);
          
          return res.json({
            ok: true,
            success: true,
            title: String(data.title || "").trim().slice(0, 200),
            content: String(data.desc || "").trim().replace(/\s+/g, " ").slice(0, 5000),
            author: String(data?.owner?.name || "").trim().slice(0, 100),
            platform: "BiliBili",
            coverImageUrl: shouldSuggestCover ? coverImageUrl : "",
            tags: tags,
            message: "Content fetched successfully",
          });
        }
      } catch {
        // Fallback to generic HTML parser below.
      }
    }

    function parseHtml(html) {
      const $ = cheerio.load(html);

      // Try extracting author from JSON-LD first, then fallback to metas/selectors.
      let jsonLdAuthor = "";
      $("script[type='application/ld+json']").each((_, el) => {
        if (jsonLdAuthor) return;
        try {
          const raw = $(el).text();
          if (!raw) return;
          const data = JSON.parse(raw);
          const arr = Array.isArray(data) ? data : [data];
          for (const item of arr) {
            const a = item?.author;
            if (!a) continue;
            if (typeof a === "string") {
              jsonLdAuthor = a;
              break;
            }
            if (Array.isArray(a) && a[0]?.name) {
              jsonLdAuthor = String(a[0].name);
              break;
            }
            if (a?.name) {
              jsonLdAuthor = String(a.name);
              break;
            }
          }
        } catch {
          // ignore malformed json-ld
        }
      });

      const parsedTitle =
        $("meta[property='og:title']").attr("content") ||
        $("meta[name='twitter:title']").attr("content") ||
        $("title").text() ||
        $("h1").first().text() ||
        "";

      $("script, style, nav, footer, header, iframe, noscript").remove();

      const parsedContent =
        $("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content") ||
        $("article").text() ||
        $(".content").text() ||
        $(".post-content").text() ||
        $(".article-content").text() ||
        $("main").text() ||
        $("body").text() ||
        "";

      const parsedAuthor =
        jsonLdAuthor ||
        $("meta[name='author']").attr("content") ||
        $("meta[property='article:author']").attr("content") ||
        $("meta[name='twitter:creator']").attr("content") ||
        $(".author").first().text() ||
        $(".post-author").first().text() ||
        "";

      const parsedPlatform =
        $("meta[property='og:site_name']").attr("content") ||
        $("meta[name='application-name']").attr("content") ||
        detectPlatformName(parsedUrl.hostname) ||
        "";

      const parsedCoverImageUrl =
        normalizeHttpUrl($("meta[property='og:image']").attr("content")) ||
        normalizeHttpUrl($("meta[name='twitter:image']").attr("content")) ||
        "";

      return {
        title: parsedTitle.trim().substring(0, 200),
        content: parsedContent.replace(/\s+/g, " ").trim().substring(0, 5000),
        author: parsedAuthor.trim().substring(0, 100),
        platform: parsedPlatform.trim().substring(0, 100),
        coverImageUrl: parsedCoverImageUrl,
      };
    }

    const requestStrategies = [
      {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Referer: `${parsedUrl.protocol}//${parsedUrl.host}/`,
      },
      {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `${parsedUrl.protocol}//${parsedUrl.host}/`,
      },
    ];

    let lastError = null;

    for (const headers of requestStrategies) {
      try {
        const response = await axios.get(url, {
          timeout: 15000,
          maxRedirects: 5,
          headers,
          validateStatus: (status) => status >= 200 && status < 500,
        });

        const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
        const html = typeof response.data === "string" ? response.data : "";

        if (!html || (!contentType.includes("text/html") && !html.includes("<html"))) {
          lastError = new Error(`Unsupported content type: ${contentType || "unknown"}`);
          continue;
        }

        const parsed = parseHtml(html);
        if (parsed.title || parsed.content) {
          title = parsed.title;
          content = parsed.content;
          author = parsed.author;
          platform = parsed.platform || platform;
          coverImageUrl = parsed.coverImageUrl || "";

          return res.json({
            ok: true,
            success: true,
            title,
            content,
            author,
            platform,
            coverImageUrl: shouldSuggestCover ? coverImageUrl : "",
            message: "Content fetched successfully",
          });
        }

        lastError = new Error("Fetched page but no readable content was extracted");
      } catch (fetchError) {
        lastError = fetchError;
      }
    }

    // Fallback: at least provide a sensible title seed so users can continue quickly
    const fallbackTitle = parsedUrl.hostname.replace(/^www\./, "");
    console.error("Failed to fetch URL:", lastError?.message || "unknown error");

    return res.json({
      ok: true,
      success: false,
      title: fallbackTitle,
      content: "",
      author: "",
      platform,
      coverImageUrl: "",
      error: "Failed to fetch content. The site may block automated requests or require JavaScript.",
      message: "Please manually copy the content from the source.",
    });

  } catch (err) {
    next(err);
  }
}

module.exports = {
  fetchExternalContent,
  importCoverImage,
  listCrawlerPlatforms,
  listAdminCrawlHistory,
  startAdminCrawl,
};
