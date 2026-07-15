// src/schemas/meme.schemas.js
// 表情/梗图库（Meme）请求校验
const { z } = require("../middleware/validate");

// tags 允许数组或逗号/空格分隔字符串，控制器统一 normalize
const tagsSchema = z.union([z.array(z.string()), z.string()]);

const createBody = z.object({
  type: z.enum(["image", "text"]),
  imageUrl: z.string().trim().max(2000).optional().default(""),
  text: z.string().trim().max(2000).optional().default(""),
  title: z.string().trim().min(1).max(120),
  tags: tagsSchema.optional().default([]),
  shared: z.boolean().optional().default(false),
});

const updateBody = z.object({
  type: z.enum(["image", "text"]).optional(),
  imageUrl: z.string().trim().max(2000).optional(),
  text: z.string().trim().max(2000).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  tags: tagsSchema.optional(),
  shared: z.boolean().optional(),
});

// use 端点无 body
const useBody = z.object({}).optional().default({});

module.exports = { createBody, updateBody, useBody };
