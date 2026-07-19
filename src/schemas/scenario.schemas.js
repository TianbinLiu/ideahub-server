// src/schemas/scenario.schemas.js
// 情景模拟（Scenario Simulation）请求校验
const { z } = require("../middleware/validate");

const commentSchema = z.object({
  id: z.string().trim().max(120).optional(),
  authorName: z.string().trim().min(1).max(80),
  authorAvatar: z.string().trim().max(2000).optional().default(""),
  text: z.string().max(2000).optional().default(""),
  likeCount: z.number().int().min(0).max(100000000).optional(),
  parentId: z.string().trim().max(120).nullable().optional(),
  isOP: z.boolean().optional(),
  stance: z.string().trim().max(200).optional().default(""),
});

const tagsSchema = z.union([z.array(z.string()), z.string()]);

const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional().default(""),
  coverImageUrl: z.string().trim().max(2000).optional().default(""),
  platform: z.string().trim().max(40).optional().default("generic"),
  tags: tagsSchema.optional().default([]),
  shared: z.boolean().optional().default(false),
  sourceUrl: z.string().trim().max(2000).optional().default(""),
  topic: z.string().trim().max(2000).optional().default(""),
  comments: z.array(commentSchema).max(200).optional().default([]),
});

const updateBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(500).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  platform: z.string().trim().max(40).optional(),
  tags: tagsSchema.optional(),
  shared: z.boolean().optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  topic: z.string().trim().max(2000).optional(),
  comments: z.array(commentSchema).max(200).optional(),
});

const historyItem = z.object({
  authorName: z.string().trim().max(80).optional().default(""),
  text: z.string().max(4000).optional().default(""),
  role: z.enum(["seed", "user", "ai"]).optional().default("user"),
  parentId: z.string().trim().max(120).nullable().optional(),
});

const playBody = z.object({
  history: z.array(historyItem).max(200).optional().default([]),
  userMessage: z.object({
    text: z.string().trim().min(1).max(4000),
    parentId: z.string().trim().max(120).nullable().optional(),
  }),
});

const captureBody = z.object({
  url: z.string().trim().min(1).max(2000),
});

// 生成种子评论区：topic（用户自拟话题）与 sourceText（真实评论素材）至少有其一。
// 「至少有其一」刻意【不在这里用 refine 做跨字段校验】，交由控制器判定并给出中文提示（见控制器）。
// 故 topic 在此为 optional：两者都缺时要能走到控制器的 badRequest("请提供话题或素材")。
//
// ⚠️ sourceText 是【一次性入参】：只作为 AI 重写的输入素材，绝不写进任何 model / 持久化字段。
// 它没有、也不允许有对应的 createBody / updateBody 字段（见 controllers/scenario.controller.js 注释）。
const generateBody = z.object({
  topic: z.string().trim().max(2000).optional(),
  // 上限必须与 scenarioAi.service.js 里 prompt 的 slice 上限、以及前端的 MAX_SOURCE_TEXT 三处一致。
  // 曾经不一致：schema/前端放行 20000 而 prompt 只取前 8000，超出部分被静默丢弃，
  // 前端却告诉用户「已截取前 20000 字作为素材」—— 界面在说谎。
  sourceText: z.string().trim().max(8000).optional(),
  platform: z.string().trim().max(40).optional().default("generic"),
  intensity: z.enum(["mild", "heated", "flame"]).optional().default("heated"),
  count: z.number().int().min(4).max(20).optional().default(12),
});

module.exports = { createBody, updateBody, playBody, captureBody, generateBody };
