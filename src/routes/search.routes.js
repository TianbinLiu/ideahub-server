// src/routes/search.routes.js
// 搜索联想，base /api/search。personal 段需登录（optionalAuth 下自动为空）。
const router = require("express").Router();
const { optionalAuth } = require("../middleware/auth");
const { suggestSearch } = require("../controllers/searchHistory.controller");

router.get("/suggest", optionalAuth, suggestSearch);

module.exports = router;
