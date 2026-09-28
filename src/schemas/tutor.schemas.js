// src/schemas/tutor.schemas.js
// 老师人格（tutor）请求校验。★ model 与 zod 同一提交（z.object 默认 strip：漏声明的字段客户端发了、服务端 201 了、读回来是空的）。
// 上限全部引用 core/format/constants 的 LIMITS / 枚举，别在这里另写数字（一处实现）。
const { z } = require("../middleware/validate");
const { POLICY_AI, HOMEWORK_MODES, LICENSE_SOURCES, KEY_DATE_KINDS, STAGE_ID_RE } = require("../tutor/core/format/constants");
const { AnchorSchema } = require("../tutor/core/format/schema");

const policyBody = z.object({
  ai: z.enum(POLICY_AI),
  homework_mode: z.enum(HOMEWORK_MODES),
  allowed_uses: z.array(z.string().trim().max(60)).max(12).optional().default([]),
  text: z.string().max(2000).optional().default(""),
});
const keyDateBody = z.object({ label: z.string().trim().min(1).max(60), at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), kind: z.enum(KEY_DATE_KINDS).optional() });
const createCourseBody = z.object({
  title: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(60),
  code: z.string().trim().max(60).optional(),
  term: z.string().trim().max(40).optional(),
  policy: policyBody,
  key_dates: z.array(keyDateBody).max(30).optional().default([]),
});
const patchCourseBody = createCourseBody.partial().extend({ policy: policyBody.partial().optional() });

const signBody = z.object({ courseId: z.string().min(1), format: z.string().trim().max(10), bytes: z.number().int().positive(), name: z.string().trim().max(200).optional() });
const pageBody = z.object({ idx: z.number().int().min(1), title: z.string().max(200).optional(), blocks: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{12}$/), text: z.string(), bbox: z.array(z.number()).max(4).optional(), fontSize: z.number().optional() })) });
const confirmBody = z.object({
  ticket: z.string().min(1).optional(), publicId: z.string().min(1).optional(), courseId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i), name: z.string().trim().max(200).optional(), mime: z.string().max(120).optional(), bytes: z.number().int().nonnegative().optional(),
  license: z.object({ source: z.enum(LICENSE_SOURCES) }).optional(), pages: z.array(pageBody).max(5000), warnings: z.array(z.string().max(300)).max(20).optional(),
});
const licenseBody = z.object({ courseId: z.string().min(1).optional(), license: z.object({ source: z.enum(LICENSE_SOURCES) }) });

const questionnaireBody = z.object({
  name: z.string().trim().min(1).max(40),
  style: z.enum(["calc_first", "socratic", "failure_first"]).optional(),
  catchphrase: z.string().trim().max(60).optional(),
  strictness: z.enum(["gentle", "firm", "strict"]).optional(),
  address: z.string().trim().max(20).optional(),
  examples_from: z.string().trim().max(60).optional(),
  extra_rules: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
});
const generateBody = z.object({ courseId: z.string().min(1), questionnaire: questionnaireBody });
const acceptBody = z.object({ indices: z.array(z.number().int().min(0)).max(50).optional() });
const emptyBody = z.object({}).passthrough().optional().default({});

const selectionBody = z.object({ anchor: AnchorSchema, text: z.string().max(2000).optional() });
const turnBody = z.object({
  kind: z.enum(["ask", "teach", "quiz-from-selection", "select", "memorize"]).optional(),
  stage: z.string().regex(STAGE_ID_RE).optional(),
  text: z.string().max(4000).optional(),
  selection: selectionBody.optional(),
  direct: z.boolean().optional(),
  selfExplain: z.string().max(2000).optional(),
});
const previewBody = z.object({ kind: z.enum(["ask", "teach"]).optional(), stage: z.string().regex(STAGE_ID_RE).optional(), text: z.string().max(4000).optional(), selection: selectionBody.optional() });
const quizBody = z.object({ stage: z.string().regex(STAGE_ID_RE).optional(), answers: z.array(z.string().max(2000)).max(20), review: z.boolean().optional() });
const progressBody = z.object({ stage: z.string().regex(STAGE_ID_RE), stepIdx: z.number().int().min(0) });
const skipBody = z.object({ stage: z.string().regex(STAGE_ID_RE) });
const feedbackBody = z.object({ seq: z.number().int().min(1), value: z.union([z.literal(1), z.literal(-1), z.null()]) });
const reviewBody = z.object({ accept: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(50).optional(), reject: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(50).optional() });
const revertBody = z.object({ opIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(50) });
// 发布（docs/02 §6）：五道门在服务端 tutorPublish.service.checkGates；这里只管形状。分类锁 teaching，所以没有 category 字段；kind 不收（服务端写死 tutor）
const publishBody = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).optional(), tags: z.array(z.string().trim().min(1).max(20)).max(6).optional(), coverEmoji: z.string().trim().max(8).optional(), aigcDeclared: z.boolean().optional(), note: z.string().trim().max(200).optional() });
// 「开始跟这位老师学」（docs/02 5.7）
const startRunBody = z.object({ persona: z.string().regex(/^[a-f0-9]{24}$/i, "persona 要是 24 位 hex 的 id") });
const importBody = z.object({ courseId: z.string().min(1).optional(), text: z.string().max(2 * 1024 * 1024).optional(), json: z.unknown().optional(), filename: z.string().max(200).optional() });

module.exports = { publishBody, startRunBody, createCourseBody, patchCourseBody, signBody, confirmBody, licenseBody, generateBody, acceptBody, emptyBody, turnBody, previewBody, quizBody, progressBody, skipBody, feedbackBody, reviewBody, revertBody, importBody };
