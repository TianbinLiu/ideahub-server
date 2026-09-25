// src/schemas/persona.schemas.js
// 人格下载（Persona）请求校验
const { z } = require("../middleware/validate");
const { voiceFieldSchema } = require("../utils/voiceSettings");

// 风格能力子结构（复用阶段5 StyleStat 形状：key/label/value/grade）
const statSchema = z.object({
  key: z.string().trim().min(1).max(60),
  label: z.string().trim().max(60).optional().default(""),
  value: z.number().min(0).max(100).optional().default(0),
  grade: z.string().trim().max(8).optional().default("E"),
});

// style 子结构
const exampleSchema = z.object({
  user: z.string().trim().min(1).max(300),
  reply: z.string().trim().min(1).max(300),
});
// style 每个字段的形状、上限与缺省值 —— **唯一一份**，下面「建」和「改」两套 schema 都从这里派生（铁律六）。
// 2026-09-05 起多出向导生成的字段（语气 / 称呼 / 开场白 / 示例对话 / 边界），全部可选，老数据不动。
const STYLE_FIELDS = {
  summary: [z.string().trim().max(2000), ""],
  catchphrases: [z.array(z.string().trim().max(120)).max(50), []],
  stats: [z.array(statSchema).max(30), []],
  stanceHint: [z.string().trim().max(500), ""],
  tone: [z.string().trim().max(300), ""],
  addressUser: [z.string().trim().max(60), ""],
  greeting: [z.string().trim().max(300), ""],
  examples: [z.array(exampleSchema).max(12), []],
  boundaries: [z.array(z.string().trim().max(120)).max(12), []],
};
const styleShape = (withDefaults) =>
  Object.fromEntries(
    Object.entries(STYLE_FIELDS).map(([k, [schema, dflt]]) => [k, withDefaults ? schema.optional().default(dflt) : schema.optional()])
  );
// 建人格 / 草稿：没给的键补缺省值（一份完整的 style）
const styleBody = z.object(styleShape(true));
// ★★ 改人格：**不补缺省值**，没发的键在解析结果里就不存在，controller 据此只改真的发了的键（PATCH 语义）。
//   为什么不能复用上面那个（2026-09-18 线上 bug）：官网人格编辑器只认 summary / catchphrases / stats /
//   stanceHint 四个字段，而 zod 会把没发的 tone / addressUser / greeting / examples / boundaries 补成空值，
//   controller 再整份替换 doc.style —— App 向导做出来的人格拿到官网上哪怕只改个价格，这五个字段就被清空，
//   200、零提示。**以后 style 再加字段，老客户端都会踩同一个坑**，所以语义定在服务端，不靠每个客户端记得回传。
const stylePatchBody = z.object(styleShape(false));

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
  // 「音频」板块（可选）：对象 = 设置，null/缺省 = 不设置
  voice: voiceFieldSchema,
});

// 从聊天文本生成人格草稿（情景编辑器「✨从聊天记录生成」）。
// chatText 下限 20：太短提炼不出风格，直接在校验层挡掉，省一次 AI 调用。
// ── 人格制作向导（2026-09-05）────────────────────────────────────────────────
// 第 1 步 基本设定
const basicsBody = z.object({
  name: z.string().trim().max(120).optional().default(""),
  role: z.string().trim().max(60).optional().default(""),
  relation: z.string().trim().max(120).optional().default(""),
  intro: z.string().trim().max(300).optional().default(""),
  addressUser: z.string().trim().max(60).optional().default(""),
});
// 第 3 步 问卷：键见 personaAi.service QUESTIONNAIRE_LABELS；值 数字/字符串/布尔/字串数组，最多 30 项
const questionnaireBody = z
  .record(z.string().max(40), z.union([z.string().trim().max(200), z.number(), z.boolean(), z.array(z.string().trim().max(60)).max(12)]))
  .refine((q) => Object.keys(q).length <= 30, { message: "questionnaire has too many items" });
// 第 2 步 素材 → POST /analyze；总量 ≤ 60k 字（服务器再抽样到 12k）
const analyzeBody = z
  .object({
    materials: z
      .array(z.object({ kind: z.enum(["chat", "posts", "notes"]).optional().default("notes"), text: z.string().trim().min(1).max(60000) }))
      .min(1)
      .max(10),
    speaker: z.string().trim().max(60).optional().default(""),
  })
  .refine((v) => v.materials.reduce((n, m) => n + m.text.length, 0) <= 60000, { message: "materials exceed 60000 characters in total" });
// analyze 的结果原样带回 generate
const analysisBody = z.object({
  catchphrases: z.array(z.string().trim().max(120)).max(20).optional().default([]),
  habits: z.record(z.string().max(40), z.string().trim().max(200)).optional().default({}),
  stances: z.array(z.string().trim().max(200)).max(12).optional().default([]),
  topics: z.array(z.string().trim().max(60)).max(20).optional().default([]),
  avoids: z.array(z.string().trim().max(60)).max(20).optional().default([]),
  samples: z.array(z.string().trim().max(300)).max(10).optional().default([]),
});
// 草稿（试聊 / 只重生成部分字段时带回）
const draftBody = z.object({
  name: z.string().trim().max(120).optional().default(""),
  description: z.string().trim().max(1000).optional().default(""),
  coverEmoji: z.string().trim().max(8).optional().default("🎭"),
  tags: z.array(z.string().trim().max(30)).max(12).optional().default([]),
  style: styleBody.optional().default({}),
});
// 第 4 步 生成：老入口只带 chatText（≥20 字）；向导带 basics / questionnaire / analysis；三者至少一个
const generateBody = z
  .object({
    chatText: z.string().trim().max(20000).optional().default(""),
    hint: z.string().trim().max(200).optional().default(""),
    basics: basicsBody.optional(),
    questionnaire: questionnaireBody.optional(),
    analysis: analysisBody.optional(),
    only: z.array(z.enum(["name", "description", "tags", "summary", "catchphrases", "stanceHint", "tone", "addressUser", "greeting", "examples", "boundaries"])).max(11).optional().default([]),
    draft: draftBody.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.chatText && v.chatText.length < 20) ctx.addIssue({ code: "custom", path: ["chatText"], message: "chatText must be at least 20 characters" });
    if (!v.chatText && !v.analysis && !v.basics) ctx.addIssue({ code: "custom", message: "provide chatText, analysis or basics" });
    if (v.only.length && !v.draft) ctx.addIssue({ code: "custom", path: ["only"], message: "only requires draft" });
  });
// 第 5 步 试聊（SSE，草稿随请求带上、不落库）
const previewChatBody = z.object({
  draft: draftBody.extend({ name: z.string().trim().min(1).max(120) }),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }))
    .min(1)
    .max(20),
  lang: z.enum(["zh", "en"]).optional().default("zh"),
  // 客户端声明自己认识哪些新事件（同 /api/companion/chat）；不声明就把求助卡退化成一句台词
  caps: z.array(z.enum(["safety", "notice"])).max(4).optional(),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  coverEmoji: z.string().trim().max(8).optional(),
  coverImageUrl: z.string().trim().max(2000).optional(),
  tags: tagsSchema.optional(),
  // 缺省 = style 整块不动；给了 = 只改给了的那几个键（见上面 stylePatchBody 的 ★★）
  style: stylePatchBody.optional(),
  shared: z.boolean().optional(),
  price: z.number().int().min(0).max(100000).optional(),
  // 对象 = 改成这个，null = 清掉，缺省 = 不动
  voice: voiceFieldSchema,
});

const equipBody = z.object({
  personaId: z.string().trim().max(120).nullable().optional().default(null),
});

module.exports = { createBody, updateBody, equipBody, styleBody, generateBody, analyzeBody, previewChatBody, draftBody };
