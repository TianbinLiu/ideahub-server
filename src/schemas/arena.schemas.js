// src/schemas/arena.schemas.js
// 卢本伟广场 · 插件相关请求校验
const { z } = require("../middleware/validate");

const suggestBody = z.object({
  draft: z.string().max(2000).optional().default(""),
  platform: z.string().trim().max(60).optional().default(""),
  context: z.string().max(4000).optional().default(""),
  persona: z.string().max(1000).optional().default(""),
  styleHints: z.array(z.string().trim().max(40)).max(6).optional().default([]),
  // 本轮要返回几条方案。默认 3；用户点「更多」续生成时递增。上限防滥用/控成本。
  count: z.number().int().min(1).max(6).optional().default(3),
  // 已经给用户看过的方案正文——本轮生成要与它们【明显不同】（「更多」时避免重复）。
  avoid: z.array(z.string().trim().max(400)).max(12).optional().default([]),
});

module.exports = { suggestBody };
