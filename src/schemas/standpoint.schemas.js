// src/schemas/standpoint.schemas.js
// 立场展开（Standpoint / Stance-Unfold）请求校验
const { z } = require("../middleware/validate");

const configBody = z.object({
  stance: z.enum(["aggressive", "peaceful", "rational", "sarcastic"]).optional(),
  personaText: z.string().max(2000).optional(),
  personalInfo: z.string().max(4000).optional(),
  autoSendEnabled: z.boolean().optional(),
  replyToMalicious: z.boolean().optional(),
  replyToQuestions: z.boolean().optional(),
});

const statusBody = z.object({
  status: z.enum(["running", "paused", "stopped"]),
});

const accountBody = z.object({
  platform: z.string().trim().min(1).max(40),
  handle: z.string().trim().min(1).max(80),
});

const simulateBody = z.object({
  kind: z.enum(["dm", "reply"]),
  platform: z.string().trim().min(1).max(40),
  fromHandle: z.string().trim().min(1).max(80),
  incomingText: z.string().trim().min(1).max(4000),
});

// 立场展开·真实到消息 ingest：真实来消息永远只出草稿，绝不自动发送。
// fromHandle 必填但允许为空（插件"起草回击"场景发 fromHandle:''），threadUrl 可选。
const ingestBody = z.object({
  kind: z.enum(["dm", "reply"]),
  platform: z.string().trim().min(1).max(40),
  fromHandle: z.string().trim().max(80),
  incomingText: z.string().trim().min(1).max(4000),
  threadUrl: z.string().trim().max(2000).optional(),
});

module.exports = { configBody, statusBody, accountBody, simulateBody, ingestBody };
