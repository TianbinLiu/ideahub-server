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

    // Try to fetch the page
    let title = "";
    let content = "";
    let author = "";
    let success = false;

    try {
      // Dynamic import for ESM modules
      const axios = (await import("axios")).default;
      const cheerio = (await import("cheerio")).default;

      const response = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        },
      });

      const html = response.data;
      const $ = cheerio.load(html);

      // Extract title - try multiple selectors
      title = 
        $("meta[property='og:title']").attr("content") ||
        $("meta[name='twitter:title']").attr("content") ||
        $("title").text() ||
        $("h1").first().text() ||
        "";

      // Extract content - try multiple selectors
      // Remove script, style, nav, footer tags
      $("script, style, nav, footer, header, iframe, noscript").remove();

      content = 
        $("article").text() ||
        $("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content") ||
        $(".content").text() ||
        $(".post-content").text() ||
        $(".article-content").text() ||
        $("main").text() ||
        $("body").text() ||
        "";

      // Extract author if available
      author = 
        $("meta[name='author']").attr("content") ||
        $("meta[property='article:author']").attr("content") ||
        $(".author").first().text() ||
        $(".post-author").first().text() ||
        "";

      // Clean up the extracted content
      title = title.trim().substring(0, 200);
      content = content.replace(/\s+/g, " ").trim().substring(0, 5000);
      author = author.trim().substring(0, 100);

      success = true;

    } catch (fetchError) {
      console.error("Failed to fetch URL:", fetchError.message);
      
      // Return partial success with error info
      return res.json({
        ok: true,
        success: false,
        title: "",
        content: "",
        author: "",
        error: "Failed to fetch content. The site may block automated requests or require JavaScript.",
        message: "Please manually copy the content from the source.",
      });
    }

    res.json({
      ok: true,
      success,
      title,
      content,
      author,
      message: success ? "Content fetched successfully" : "Failed to fetch content",
    });

  } catch (err) {
    next(err);
  }
}

module.exports = {
  fetchExternalContent,
};
