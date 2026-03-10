const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware/auth");
const {
	fetchExternalContent,
	listCrawlerPlatforms,
	listAdminCrawlHistory,
	startAdminCrawl,
} = require("../controllers/scraper.controller");

/**
 * POST /api/scraper/fetch
 * Fetch content from external URL
 * Requires authentication to prevent abuse
 */
router.post("/fetch", requireAuth, fetchExternalContent);

/**
 * GET /api/scraper/admin/platforms
 * Admin-only platform capability list
 */
router.get("/admin/platforms", requireAuth, requireRole("admin"), listCrawlerPlatforms);

/**
 * GET /api/scraper/admin/history
 * Admin-only crawl history
 */
router.get("/admin/history", requireAuth, requireRole("admin"), listAdminCrawlHistory);

/**
 * POST /api/scraper/admin/crawl
 * Admin-only crawl trigger for importing external videos into ideas
 */
router.post("/admin/crawl", requireAuth, requireRole("admin"), startAdminCrawl);

module.exports = router;
