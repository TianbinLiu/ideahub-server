// src/schemas/speakingStyle.schemas.js
// 发言风格面板（Speaking Style Panel）请求校验
const { z } = require("../middleware/validate");

// 生成档案 body：可选的 styleTally（插件记录的风格选择次数，key→次数）
const generateBody = z.object({
  styleTally: z.record(z.string(), z.number()).optional(),
});

module.exports = { generateBody };
