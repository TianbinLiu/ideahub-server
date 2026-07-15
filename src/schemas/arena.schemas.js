// src/schemas/arena.schemas.js
// 卢本伟广场 · 插件相关请求校验
const { z } = require("../middleware/validate");

const suggestBody = z.object({
  draft: z.string().max(2000).optional().default(""),
  platform: z.string().trim().max(60).optional().default(""),
  context: z.string().max(4000).optional().default(""),
  persona: z.string().max(1000).optional().default(""),
  styleHints: z.array(z.string().trim().max(40)).max(6).optional().default([]),
});

module.exports = { suggestBody };
