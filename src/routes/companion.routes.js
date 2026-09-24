/**
 * @file companion.routes.js - 首页看板娘数字人：配置探测 + SSE 流式对话
 * @category Route
 * @base_path /api/companion
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * API端点:
 * @endpoint GET  /config - 这台服务器有没有配 AI/TTS、看板娘叫什么（游客可查，决定前端画不画对话框）；
 *                          登录用户还会拿到自己的数字人设置解析结果：persona / model / voiceSettings（见 companionSetting.service）
 * @endpoint GET  /settings - 登录用户的数字人三项选择（人格 / Live2D 模型 / 音频覆盖）+ 解析结果
 * @endpoint PUT  /settings - 改选择：{ personaId?, modelId?, voice? }，缺省不动、null 清掉；人格要能选用（公开/自己的，付费需已购）；
 *                           voice 可以是完整 VoiceSettings（含 mix / templateId），也可以只给 { templateId } 由服务端从声音市场的模板展开
 * @endpoint POST /chat   - 流式对话（text/event-stream）。请求体两种写法：
 *   · 按会话（2026-09 起）：{ message, threadId?, lang? } —— 历史由服务端持有，不给 threadId 就开新会话；
 *   · 旧写法：{ messages[], lang? } —— 客户端自带最近 ≤20 条，服务端不存（已发布的旧版客户端还在用，保留）。
 *   事件：
 *   event: thread    data: {threadId, title}                                              ← 仅按会话时，最先到
 *   event: sentence  data: {index, text, emotion, face, action, tts:{emotion,instruct}}  ← 一句一条，前端按句调 /api/tts 并切表情
 *   event: token     data: {t}                                                            ← 原始增量，仅供"打字机"显示
 *   event: done      data: {text, threadId?, context?}                                    ← 剥掉标签后的整段正文；按会话时带上下文用量
 *   event: error     data: {message, threadId?, context?}
 *   context = {used, budget, ratio, level: ok|warn|compact|full}（见 chatMemory.service.contextState）
 *
 * ★ 为什么是 SSE 而不是等整段生成完再返回：像真人的关键是"第一句话 1 秒内开口"。
 *   整段生成要 3～8 秒，逐句转发后前端拿到第一句就能去合成语音、切表情。
 * ★ 为什么必须 requireAuth + aiRateLimit：每次调用都花 LLM token（还会连带触发 TTS 计费）。
 *   与 /api/tts 同一条理由，见那边的注释。游客只能看到对话框上的「登录后聊天」。
 * ★ X-Accel-Buffering: no —— 线上前面有 nginx，不关缓冲的话 SSE 会被攒成一整块最后才吐，
 *   等于没做流式。这一条改 nginx 配置也能做，但放在响应头里不依赖运维记得配。
 * ★ 客户端断开（req close）时 abort 上游请求：否则模型把整段生成完、token 照扣。
 * ★ 会话、记忆、上下文用量与自动提纯全在 chatMemory.service；会话的查看与删除在 /api/chat（chatThreads.routes.js）。
 *
 * 依赖:
 * @uses {services/aiClient.js} - aiChatStream / hasAiKey
 * @uses {services/companion.service.js} - 提示词、切句、标签解析、TTS 参数
 * @uses {services/chatMemory.service.js} - 会话持久化 / 上下文组装 / 用量 / 提纯
 * @uses {middleware/auth.js} - requireAuth / optionalAuth
 * @uses {middleware/rateLimit.js} - aiRateLimit
 */
const express = require("express");
const { z } = require("zod");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { hasAiKey } = require("../services/aiClient");
const companion = require("../services/companion.service");
const chatMemory = require("../services/chatMemory.service");
const { loadCompanionSetup, updateCompanionSetting, personaPromptLine, defaultVoiceId } = require("../services/companionSetting.service");
const { voiceFieldSchema, resolveVoiceSettings } = require("../utils/voiceSettings");
const billing = require("../services/billing.service");
const { priceOf } = require("../config/tokens");

const router = express.Router();

const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1000;

const chatBodySchema = z
  .object({
    // 旧写法：客户端自带历史（服务端不存）
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
        }),
      )
      .min(1)
      .max(MAX_HISTORY)
      .optional(),
    // 按会话：只发新的一句
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS).optional(),
    threadId: z.string().trim().max(64).nullable().optional(),
    lang: z.enum(["zh", "en"]).optional(),
  })
  .refine((b) => Boolean(b.messages) !== Boolean(b.message), { message: "send either message or messages[]" });

const settingsBodySchema = z.object({
  personaId: z.string().trim().max(64).nullable().optional(),
  modelId: z.string().trim().max(64).nullable().optional(),
  voice: voiceFieldSchema,
});

function companionName() {
  return String(process.env.COMPANION_NAME || "").trim() || companion.DEFAULT_NAME;
}

router.get("/config", optionalAuth, async (req, res, next) => {
  try {
    // 游客只有服务端默认；登录用户带上自己的人格 / 模型 / 嗓子（读取时解析，被删的选择静默回退）
    const setup = req.user ? await loadCompanionSetup({ userId: req.user._id, req }) : null;
    const voiceSettings = setup ? setup.voice : resolveVoiceSettings([], { defaultVoiceId: defaultVoiceId() });
    res.json({
      ok: true,
      name: companionName(),
      enabled: hasAiKey(),
      tts: Boolean(process.env.TTS_API_KEY),
      // 豆包音色 id（老字段，= voiceSettings.voiceId）：不配就用 tts.routes.js 的默认音色
      voice: voiceSettings.voiceId,
      voiceSettings,
      persona: setup ? setup.persona : null,
      personaSource: setup ? setup.personaSource : "",
      model: setup ? setup.model : null,
      loginRequired: true,
    });
  } catch (e) {
    next(e);
  }
});

router.get("/settings", requireAuth, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await loadCompanionSetup({ userId: req.user._id, req })) });
  } catch (e) {
    next(e);
  }
});

router.put("/settings", requireAuth, async (req, res, next) => {
  const parsed = settingsBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    // 自己写的人话（「只能混 1.0 音色」）直接当 message，与 middleware/error.js 对 ZodError 的处理一致
    const custom = parsed.error.issues.find((i) => i.code === "custom" && i.message);
    return res.status(400).json({ message: custom ? custom.message : "invalid settings", code: "VALIDATION_ERROR", details: parsed.error.issues });
  }
  try {
    res.json({ ok: true, ...(await updateCompanionSetting({ userId: req.user._id, req, patch: parsed.data })) });
  } catch (e) {
    next(e);
  }
});

router.post("/chat", requireAuth, aiRateLimit({ max: 20, scope: "companion" }), async (req, res, next) => {
  const parsed = chatBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ message: "invalid messages", code: "VALIDATION_ERROR", details: parsed.error.issues });
  }
  if (!hasAiKey()) {
    return res.status(501).json({ message: "AI not configured", code: "AI_NOT_CONFIGURED" });
  }

  // 旧写法：最后一条必须是用户说的话；助手历史只用来续上下文
  const history = parsed.data.messages;
  if (history && history[history.length - 1].role !== "user") {
    return res.status(400).json({ message: "last message must be from user", code: "VALIDATION_ERROR" });
  }

  try {
    // 装了人格 → 提示词多一段人设、每句的 TTS 指令带上人设的语调；没装 → 与从前逐字相同
    const setup = await loadCompanionSetup({ userId: req.user._id, req });
    const system = companion.buildSystemPrompt({
      name: companionName(),
      userName: req.user.displayName || req.user.username || "",
      lang: parsed.data.lang || "zh",
      personaLine: personaPromptLine(setup.persona),
    });
    // 人格卡带示例对话时插几组 few-shot（personaExampleMessages），模型更像 TA
    const prefix = [{ role: "system", content: system }, ...companion.personaExampleMessages(setup.persona)];

    // SSE 流式回复的实现在 companion.service.streamCompanionReply（与人格向导的试聊共用）
    if (history) {
      // ★★ 计费（方案 9.1 的 R1.5）：陪聊此前**一分钱不扣** —— `CHAT_TURN_TOKENS` 早就有价，
      //   只是从来没有一处调用过扣费。按闸门本身算（20 次/分钟），单账号理论日上限是四位数美元。
      //   「先扣后转发」的顺序不能让步；此刻 SSE 还没开始，402/403 可以正常回 JSON。
      const pre = await billing.preAuthorize({ user: req.user, cost: priceOf("chat", {}), memo: "chat companion" });
      if (!pre.ok) return res.status(pre.status).json(pre.body);
      let produced = false;
      await companion.streamCompanionReply({
        res,
        messages: [...prefix, ...history.map((m) => ({ role: m.role, content: m.content }))],
        ttsInstruct: setup.voice.instruct,
        finish: ({ text }) => {
          produced = Boolean(text);
          return {};
        },
      });
      // 一个字都没出来 = 上游没受理（敏感词 / 限流 / 挂了）⇒ 退款，与方舟那条口径逐字相同
      if (!produced) await billing.refundUnaccepted({ user: req.user, cost: pre.cost, memo: "chat companion" });
      else await billing.noteFreeCall({ user: req.user, cost: pre.cost, memo: "chat companion", snapshot: pre.before });
      return;
    }

    // 按会话：先存下用户这句（threadId 不是自己的 → 404，此时还没开始 SSE），再从服务端历史组装上下文
    const thread = await chatMemory.beginTurn({
      userId: req.user._id,
      scene: "companion",
      threadId: parsed.data.threadId,
      text: parsed.data.message,
      personaId: setup.persona && setup.persona._id,
    });
    const { messages, estPrompt } = await chatMemory.buildContextMessages({ thread, prefix });
    const pre = await billing.preAuthorize({ user: req.user, cost: priceOf("chat", {}), memo: "chat companion" });
    if (!pre.ok) return res.status(pre.status).json(pre.body);
    let produced = false;
    await companion.streamCompanionReply({
      res,
      messages,
      ttsInstruct: setup.voice.instruct,
      thread: { threadId: String(thread._id), title: thread.title || "" },
      finish: ({ text, rawText, aborted, usage }) => {
        produced = Boolean(text);
        return chatMemory.finishTurn({ thread, displayText: text, modelText: rawText.replace(/\s*\[[^\]]*$/, ""), usage, estPrompt, aborted });
      },
    });
    if (!produced) await billing.refundUnaccepted({ user: req.user, cost: pre.cost, memo: "chat companion" });
    else await billing.noteFreeCall({ user: req.user, cost: pre.cost, memo: "chat companion", snapshot: pre.before });
    // 用量到阈值 → 回复发完之后再提纯（不让用户等），失败只记日志
    chatMemory.maybeCompact(thread._id).catch((e) => console.warn("[companion] compact failed:", (e && e.message) || e));
  } catch (e) {
    if (res.headersSent) return; // SSE 已经开始，错误已由 streamCompanionReply 以 error 事件告知
    next(e);
  }
});

module.exports = router;
