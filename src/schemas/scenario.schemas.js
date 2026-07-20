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

// chat 场景：参与者花名册 + 种子对话。宽松校验(控制器再 normalize)，未知键 zod 默认 strip。
const participantSchema = z.object({
  id: z.string().trim().max(120).optional(),
  name: z.string().trim().max(80).optional().default(""),
  avatar: z.string().trim().max(500).optional().default(""),
  role: z.string().trim().max(80).optional().default(""),
  isSelf: z.boolean().optional(),
  goal: z.string().trim().max(400).optional().default(""),
});
const chatMessageSchema = z.object({
  id: z.string().trim().max(120).optional(),
  senderId: z.string().trim().max(120).optional().default(""),
  text: z.string().max(2000).optional().default(""),
});

// sceneKind / category 在 schema 里只做长度守卫，真正的枚举归一交给控制器（越界→comment/other）。
const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500).optional().default(""),
  coverImageUrl: z.string().trim().max(2000).optional().default(""),
  platform: z.string().trim().max(40).optional().default("generic"),
  sceneKind: z.string().trim().max(20).optional(),
  category: z.string().trim().max(40).optional(),
  tags: tagsSchema.optional().default([]),
  shared: z.boolean().optional().default(false),
  sourceUrl: z.string().trim().max(2000).optional().default(""),
  topic: z.string().trim().max(2000).optional().default(""),
  comments: z.array(commentSchema).max(200).optional().default([]),
  participants: z.array(participantSchema).max(30).optional().default([]),
  messages: z.array(chatMessageSchema).max(300).optional().default([]),
});

const updateBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(500).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  platform: z.string().trim().max(40).optional(),
  sceneKind: z.string().trim().max(20).optional(),
  category: z.string().trim().max(40).optional(),
  tags: tagsSchema.optional(),
  shared: z.boolean().optional(),
  sourceUrl: z.string().trim().max(2000).optional(),
  topic: z.string().trim().max(2000).optional(),
  comments: z.array(commentSchema).max(200).optional(),
  participants: z.array(participantSchema).max(30).optional(),
  messages: z.array(chatMessageSchema).max(300).optional(),
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

// AI 分析并自动填写展示信息：入参是【正在编辑中的】评论，可能字段残缺（authorName 为空、
// 正文为空皆合法），故这里用【宽松】的评论形状，绝不能套 createBody 里 authorName.min(1) 的
// 严格校验 —— 否则用户填了一半点「AI 自动填写」会因某条评论没填名字而整个请求 400。
// zod 默认 strip 未知字段（id/parentId/likeCount 等），透传进来也会被安静丢掉，只留下分析要用的。
const analyzeCommentSchema = z.object({
  authorName: z.string().trim().max(80).optional().default(""),
  text: z.string().max(2000).optional().default(""),
  stance: z.string().trim().max(200).optional().default(""),
  isOP: z.boolean().optional(),
});

// topic 与 comments 至少有其一（交由控制器判定并给中文提示，与 generateBody 同一取舍）。
const analyzeBody = z.object({
  topic: z.string().trim().max(2000).optional().default(""),
  platform: z.string().trim().max(40).optional().default("generic"),
  comments: z.array(analyzeCommentSchema).max(200).optional().default([]),
});

module.exports = { createBody, updateBody, playBody, captureBody, generateBody, analyzeBody };
