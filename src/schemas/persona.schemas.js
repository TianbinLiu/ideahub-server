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
  tags: tagsSchema.optional().default([]),
  style: styleBody.optional().default({}),
  shared: z.boolean().optional().default(false),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  coverEmoji: z.string().trim().max(8).optional(),
  tags: tagsSchema.optional(),
  style: styleBody.optional(),
  shared: z.boolean().optional(),
});

const equipBody = z.object({
  personaId: z.string().trim().max(120).nullable().optional().default(null),
});

module.exports = { createBody, updateBody, equipBody, styleBody };
