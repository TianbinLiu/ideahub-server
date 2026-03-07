/**
 * Scraper Controller
 * Fetches content from external URLs for creating ideas from external sources
 */

const AppError = require("../utils/AppError");

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

    // Dynamic import for ESM modules
    const axios = (await import("axios")).default;
    const cheerio = (await import("cheerio")).default;

    function parseHtml(html) {
      const $ = cheerio.load(html);

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
        $("meta[name='author']").attr("content") ||
        $("meta[property='article:author']").attr("content") ||
        $(".author").first().text() ||
        $(".post-author").first().text() ||
        "";

      return {
        title: parsedTitle.trim().substring(0, 200),
        content: parsedContent.replace(/\s+/g, " ").trim().substring(0, 5000),
        author: parsedAuthor.trim().substring(0, 100),
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

          return res.json({
            ok: true,
            success: true,
            title,
            content,
            author,
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
      error: "Failed to fetch content. The site may block automated requests or require JavaScript.",
      message: "Please manually copy the content from the source.",
    });

  } catch (err) {
    next(err);
  }
}

module.exports = {
  fetchExternalContent,
};
