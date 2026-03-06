const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { fetchExternalContent } = require("../controllers/scraper.controller");

/**
 * POST /api/scraper/fetch
 * Fetch content from external URL
 * Requires authentication to prevent abuse
 */
router.post("/fetch", requireAuth, fetchExternalContent);

module.exports = router;
