// src/schemas/bounty.schemas.js
// 赏金猎人（Bounty Hunter）请求校验
const { z } = require("../middleware/validate");

const tagsSchema = z.union([z.array(z.string()), z.string()]);

const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5000).optional().default(""),
  reward: z.number().min(0).max(100000000),
  platform: z.string().trim().max(40).optional().default("other"),
  targetUrl: z.string().trim().min(1).max(2000),
  tags: tagsSchema.optional().default([]),
  slots: z.number().int().min(1).max(100000).optional().default(1),
  deadline: z.string().trim().max(60).nullable().optional(),
});

const updateBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(5000).optional(),
  reward: z.number().min(0).max(100000000).optional(),
  platform: z.string().trim().max(40).optional(),
  targetUrl: z.string().trim().min(1).max(2000).optional(),
  tags: tagsSchema.optional(),
  slots: z.number().int().min(1).max(100000).optional(),
  deadline: z.string().trim().max(60).nullable().optional(),
});

const statusBody = z.object({
  status: z.enum(["open", "closed", "completed"]),
});

const submitBody = z.object({
  speechText: z.string().trim().min(1).max(4000),
  screenshotUrl: z.string().trim().max(2000).optional().default(""),
  note: z.string().trim().max(2000).optional().default(""),
});

const reviewBody = z.object({
  status: z.enum(["approved", "rejected"]),
});

const commentBody = z.object({
  text: z.string().trim().min(1).max(2000),
  imageUrl: z.string().trim().max(2000).optional().default(""),
  // 顶楼回复时不传 / 传 null；楼中楼传其顶楼的评论 id。
  // 合法性（是否属于同一 bounty、是否只有一层）由控制器判定，见 bounty.controller.js
  parentId: z.string().trim().optional().nullable(),
});

module.exports = { createBody, updateBody, statusBody, submitBody, reviewBody, commentBody };
