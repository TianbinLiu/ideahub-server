// src/schemas/voiceTemplate.schemas.js
// 声音市场（混音模板）请求校验。recipe 复用 utils/voiceSettings 的 mixArraySchema：形状、1～3 味、每味都在
// 1.0 可混音目录里（2.0 进来是 400，message 说明只能混 1.0）。权重不要求和为 1，入库前由 normalizeMix 归一。
const { z } = require("../middleware/validate");
const { mixArraySchema, INSTRUCT_MAX } = require("../utils/voiceSettings");

const nameSchema = z.string().trim().min(1).max(60);
const descriptionSchema = z.string().trim().max(300);
const rateSchema = z.number().min(-50).max(100).nullable();
const pitchSchema = z.number().min(-12).max(12).nullable();
const instructSchema = z.string().trim().max(INSTRUCT_MAX);

const createBody = z.object({
  name: nameSchema,
  description: descriptionSchema.optional().default(""),
  recipe: mixArraySchema({ min: 1 }),
  rate: rateSchema.optional().default(null),
  pitch: pitchSchema.optional().default(null),
  instruct: instructSchema.optional().default(""),
  expressive: z.boolean().optional().default(true),
  shared: z.boolean().optional().default(false),
});

const updateBody = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  recipe: mixArraySchema({ min: 1 }).optional(),
  rate: rateSchema.optional(),
  pitch: pitchSchema.optional(),
  instruct: instructSchema.optional(),
  expressive: z.boolean().optional(),
  shared: z.boolean().optional(),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(40).optional().default(12),
  sort: z.enum(["new", "hot"]).optional().default("new"),
  q: z.string().trim().max(80).optional().default(""),
  scope: z.enum(["all", "mine"]).optional().default("all"),
});

module.exports = { createBody, updateBody, listQuery };
