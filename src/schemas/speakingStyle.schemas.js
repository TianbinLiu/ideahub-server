// src/schemas/speakingStyle.schemas.js
// 发言风格面板（Speaking Style Panel）请求校验
const { z } = require("../middleware/validate");

// 生成档案 body：可选的 styleTally（插件记录的风格选择次数，key→次数）
const generateBody = z.object({
  styleTally: z.record(z.string(), z.number()).optional(),
});

// 加入风格记忆 body：用户自己的发言样本（前端粘贴多条，或插件在本人主页/评论页就地收集）
const samplesBody = z.object({
  texts: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  source: z.enum(["paste", "capture"]).optional(),
  platform: z.string().trim().max(40).optional(),
});

module.exports = { generateBody, samplesBody };
