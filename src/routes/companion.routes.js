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
 * @endpoint PUT  /consent  - 记下「我已了解」（加州 SB 243 告知同意）；版本变了要重新同意
 * @endpoint PUT  /settings - 改选择：{ personaId?, modelId?, voice? }，缺省不动、null 清掉；人格要能选用（公开/自己的，付费需已购）；
 *                           voice 可以是完整 VoiceSettings（含 mix / templateId），也可以只给 { templateId } 由服务端从声音市场的模板展开
 * @endpoint POST /chat   - 流式对话（text/event-stream）。请求体两种写法：
 *   · 按会话（2026-09 起）：{ message, threadId?, lang? } —— 历史由服务端持有，不给 threadId 就开新会话；
 *   · 旧写法：{ messages[], lang? } —— 客户端自带最近 ≤20 条，服务端不存（已发布的旧版客户端还在用，保留）。
 *   事件：
 *   event: thread    data: {threadId, title}                                              ← 仅按会话时，最先到
 *   event: notice    data: {kind:"ai_disclosure", text}                                   ← AI 身份告知（新会话 / 空闲 30 分钟 / 每 3 小时）
 *   event: safety    data: {kind:"crisis", trigger, region, title, body, resources[], policyUrl, version}
 *                    ← 自伤危机求助卡：用户这句命中（trigger=input，0 token、不调模型）或模型输出被拦下（trigger=output，已 abort 上游）
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
 * @uses {services/chatSafety.service.js} - 自伤检测 / 求助资源 / 匿名转介计数（协议详见官网 /safety/ai-chat）
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
const chatSafety = require("../services/chatSafety.service");
const {
  loadCompanionSetup,
  updateCompanionSetting,
  personaPromptLine,
  defaultVoiceId,
  consentVersion,
  consentRequired,
  hasConsented,
  recordConsent,
} = require("../services/companionSetting.service");
const { voiceFieldSchema, resolveVoiceSettings } = require("../utils/voiceSettings");

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
    // 客户端声明自己认识哪些新事件；不声明的老客户端会收到退化形式（求助卡走 sentence）
    caps: z.array(z.enum(["safety", "notice"])).max(4).optional(),
  })
  .refine((b) => Boolean(b.messages) !== Boolean(b.message), { message: "send either message or messages[]" });

const settingsBodySchema = z.object({
  personaId: z.string().trim().max(64).nullable().optional(),
  modelId: z.string().trim().max(64).nullable().optional(),
  voice: voiceFieldSchema,
});

/** AI 身份告知的一句话（纽约 GBL §1702：交互开始与每 3 小时） */
function aiNoticeText(name, lang) {
  return lang === "en"
    ? `You're chatting with an AI. ${name} is not a real person and can be wrong. Remember to take a break.`
    : `你正在和 AI 聊天，${name}不是真人，回答可能出错。聊久了记得休息一下。`;
}

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
      // 自伤危机协议与 AI 告知（加州 SB 243 / 纽约 GBL）：前端据此画常驻提示、首次同意框与求助卡
      safety: {
        policyUrl: "/safety/ai-chat",
        version: chatSafety.PROTOCOL_VERSION,
        consentVersion: consentVersion(),
        consentRequired: consentRequired(),
        consented: setup ? hasConsented(setup) : false,
        ...chatSafety.crisisResources({ country: chatSafety.countryOf(req), lang: String(req.query.lang || "zh") }),
      },
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

/**
 * 首次陪聊前的告知同意（加州 SB 243 §22602(a) 告知是 AI、§22604「可能不适合部分未成年人」）。
 * 前端在同意框上点「我已了解」时调用；版本变了要重新同意。
 */
router.put("/consent", requireAuth, async (req, res, next) => {
  try {
    const { version, at } = await recordConsent({ userId: req.user._id });
    res.json({ ok: true, consent: { version, at }, consented: true });
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

  const lang = parsed.data.lang || "zh";
  const country = chatSafety.countryOf(req);
  const caps = parsed.data.caps || [];

  try {
    // 装了人格 → 提示词多一段人设、每句的 TTS 指令带上人设的语调；没装 → 与从前逐字相同
    const setup = await loadCompanionSetup({ userId: req.user._id, req });
    // 没看过告知就不让聊（开关默认关着，等前端的同意框上线再打开）
    if (consentRequired() && !hasConsented(setup)) {
      return res.status(428).json({
        message: "consent required",
        code: "CONSENT_REQUIRED",
        consentVersion: consentVersion(),
        safety: { policyUrl: "/safety/ai-chat", ...chatSafety.crisisResources({ country, lang }) },
      });
    }
    const system = companion.buildSystemPrompt({
      name: companionName(),
      userName: req.user.displayName || req.user.username || "",
      lang,
      personaLine: personaPromptLine(setup.persona),
    });
    // 人格卡带示例对话时插几组 few-shot（personaExampleMessages），模型更像 TA；
    // 安全底线在 few-shot 之后再发一次，免得被示例对话稀释（companion.service.safetySystemMessage）
    const prefix = [{ role: "system", content: system }, ...companion.personaExampleMessages(setup.persona), companion.safetySystemMessage()];

    // SSE 流式回复的实现在 companion.service.streamCompanionReply（与人格向导的试聊共用）
    if (history) {
      // ★ 旧写法同样要查输入侧：条文管的是「我们这套服务」，不是「客户端用了哪种请求体」。
      //   这条链路服务端不存历史，所以只发卡片、记匿名计数，不写库。
      const legacyVerdict = chatSafety.detectSelfHarm(history[history.length - 1].content);
      if (legacyVerdict.hit) {
        const card = chatSafety.crisisCard({ trigger: "input", country, lang });
        await chatSafety.recordReferral({ scene: "companion", trigger: "input", country });
        const send = companion.openSse(res);
        for (const e of companion.crisisCardEvents({ card, caps, ttsInstruct: setup.voice.instruct })) send(e.event, e.data);
        send("done", { text: "", safety: true });
        res.end();
        return;
      }
      await companion.streamCompanionReply({
        res,
        messages: [...prefix, ...history.map((m) => ({ role: m.role, content: m.content }))],
        ttsInstruct: setup.voice.instruct,
        country,
        lang,
        caps,
        scene: "companion",
      });
      return;
    }

    // 按会话：先存下用户这句（threadId 不是自己的 → 404，此时还没开始 SSE），再从服务端历史组装上下文
    const { thread, disclosureDue } = await chatMemory.beginTurn({
      userId: req.user._id,
      scene: "companion",
      threadId: parsed.data.threadId,
      text: parsed.data.message,
      personaId: setup.persona && setup.persona._id,
    });
    const threadEvent = { threadId: String(thread._id), title: thread.title || "" };

    // ★ 输入侧：用户流露自伤念头 → **不调模型**（0 token），存一条求助卡进历史，直接把卡片发回去。
    //   依据加州 SB 243 §22602(b)(1) 与纽约 GBL §1701。用户下一句照常能继续聊。
    const verdict = chatSafety.detectSelfHarm(parsed.data.message);
    if (verdict.hit) {
      const card = chatSafety.crisisCard({ trigger: "input", country, lang });
      // 标题取自第一句用户消息 —— 但危机那句不该成为会话列表上的标题（用户自己回头看也刺眼）
      await chatMemory.clearTitleIfEquals(thread, parsed.data.message);
      threadEvent.title = thread.title || ""; // 标题在上面几行刚被清掉，别把旧值发给前端
      await chatMemory.appendMessage(thread, { role: "system", kind: "safety", displayText: chatSafety.crisisPlainText(card) });
      await chatSafety.recordReferral({ scene: "companion", trigger: "input", country });
      const send = companion.openSse(res);
      send("thread", threadEvent);
      if (disclosureDue) {
        send("notice", { kind: "ai_disclosure", text: aiNoticeText(companionName(), lang) });
        await chatMemory.markDisclosed(thread);
      }
      // 老客户端不认 safety 事件，就把求助文字当成一句台词发过去（companion.crisisCardEvents 一处实现）
      for (const e of companion.crisisCardEvents({ card, caps, ttsInstruct: setup.voice.instruct })) send(e.event, e.data);
      send("done", { text: "", threadId: threadEvent.threadId, context: chatMemory.contextState(thread), safety: true });
      res.end();
      return;
    }

    const { messages, estPrompt } = await chatMemory.buildContextMessages({ thread, prefix });
    await companion.streamCompanionReply({
      res,
      messages,
      ttsInstruct: setup.voice.instruct,
      thread: threadEvent,
      prelude: disclosureDue
        ? [{ event: "notice", data: { kind: "ai_disclosure", text: aiNoticeText(companionName(), lang) } }]
        : [],
      onPrelude: () => chatMemory.markDisclosed(thread),
      // 输出侧守卫默认就是开的（companion.service：检测、发卡、abort、匿名计数都在那里）；
      // 这里只补一件它做不了的事 —— 把求助卡也写进这个会话的历史，用户翻回来还看得到。
      country,
      lang,
      caps,
      scene: "companion",
      finish: async ({ text, rawText, aborted, usage, blocked }) => {
        if (blocked) {
          const card = chatSafety.crisisCard({ trigger: "output", country, lang });
          await chatMemory.appendMessage(thread, { role: "system", kind: "safety", displayText: chatSafety.crisisPlainText(card) });
        }
        return chatMemory.finishTurn({ thread, displayText: text, modelText: rawText.replace(/\s*\[[^\]]*$/, ""), usage, estPrompt, aborted });
      },
    });
    // 用量到阈值 → 回复发完之后再提纯（不让用户等），失败只记日志
    chatMemory.maybeCompact(thread._id).catch((e) => console.warn("[companion] compact failed:", (e && e.message) || e));
  } catch (e) {
    if (res.headersSent) return; // SSE 已经开始，错误已由 streamCompanionReply 以 error 事件告知
    next(e);
  }
});

module.exports = router;
