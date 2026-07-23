// src/schemas/persona.schemas.js
// 人格下载（Persona）请求校验
const { z } = require("../middleware/validate");

// 风格能力子结构（复用阶段5 StyleStat 形状：key/label/value/grade）
const statSchema = z.object({
  key: z.string().trim().min(1).max(60),
  label: z.string().trim().max(60).optional().default(""),
  value: z.number().min(0).max(100).optional().default(0),
  grade: z.string().trim().max(8).optional().default("E"),
});

// style 子结构
const styleBody = z.object({
  summary: z.string().trim().max(2000).optional().default(""),
  catchphrases: z.array(z.string().trim().max(120)).max(50).optional().default([]),
  stats: z.array(statSchema).max(30).optional().default([]),
  stanceHint: z.string().trim().max(500).optional().default(""),
});

const tagsSchema = z.union([z.array(z.string()), z.string()]);

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional().default(""),
  coverEmoji: z.string().trim().max(8).optional().default("🎭"),
  coverImageUrl: z.string().trim().max(2000).optional().default(""),
  tags: tagsSchema.optional().default([]),
  style: styleBody.optional().default({}),
  shared: z.boolean().optional().default(false),
  // 售价（赏金点数，0=免费）。上限与 Persona 模型/controller toPrice 一致。
  price: z.number().int().min(0).max(100000).optional().default(0),
});

// 从聊天文本生成人格草稿（情景编辑器「✨从聊天记录生成」）。
// chatText 下限 20：太短提炼不出风格，直接在校验层挡掉，省一次 AI 调用。
const generateBody = z.object({
  chatText: z.string().trim().min(20).max(20000),
  hint: z.string().trim().max(200).optional().default(""),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  coverEmoji: z.string().trim().max(8).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  tags: tagsSchema.optional(),
  style: styleBody.optional(),
  shared: z.boolean().optional(),
  price: z.number().int().min(0).max(100000).optional(),
});

const equipBody = z.object({
  personaId: z.string().trim().max(120).nullable().optional().default(null),
});

module.exports = { createBody, updateBody, equipBody, styleBody, generateBody };
