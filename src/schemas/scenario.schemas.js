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

const generateBody = z.object({
  topic: z.string().trim().min(1).max(2000),
  platform: z.string().trim().max(40).optional().default("generic"),
  intensity: z.enum(["mild", "heated", "flame"]).optional().default("heated"),
  count: z.number().int().min(4).max(20).optional().default(12),
});

module.exports = { createBody, updateBody, playBody, captureBody, generateBody };
