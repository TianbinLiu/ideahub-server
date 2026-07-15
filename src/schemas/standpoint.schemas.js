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

module.exports = { configBody, statusBody, accountBody, simulateBody };
