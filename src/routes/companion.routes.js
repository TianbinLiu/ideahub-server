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
 * @endpoint POST /chat   - 流式对话（text/event-stream）。事件：
 *   event: sentence  data: {index, text, emotion, face, action, tts:{emotion,instruct}}  ← 一句一条，前端按句调 /api/tts 并切表情
 *   event: token     data: {t}                                                            ← 原始增量，仅供"打字机"显示
 *   event: done      data: {text}                                                         ← 剥掉标签后的整段正文
 *   event: error     data: {message}
 *
 * ★ 为什么是 SSE 而不是等整段生成完再返回：像真人的关键是"第一句话 1 秒内开口"。
 *   整段生成要 3～8 秒，逐句转发后前端拿到第一句就能去合成语音、切表情。
 * ★ 为什么必须 requireAuth + aiRateLimit：每次调用都花 LLM token（还会连带触发 TTS 计费）。
 *   与 /api/tts 同一条理由，见那边的注释。游客只能看到对话框上的「登录后聊天」。
 * ★ X-Accel-Buffering: no —— 线上前面有 nginx，不关缓冲的话 SSE 会被攒成一整块最后才吐，
 *   等于没做流式。这一条改 nginx 配置也能做，但放在响应头里不依赖运维记得配。
 * ★ 客户端断开（req close）时 abort 上游请求：否则模型把整段生成完、token 照扣。
 *
 * 依赖:
 * @uses {services/aiClient.js} - aiChatStream / hasAiKey
 * @uses {services/companion.service.js} - 提示词、切句、标签解析、TTS 参数
 * @uses {middleware/auth.js} - requireAuth / optionalAuth
 * @uses {middleware/rateLimit.js} - aiRateLimit
 */
const express = require("express");
const { z } = require("zod");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { aiRateLimit } = require("../middleware/rateLimit");
const { hasAiKey, aiChatStream } = require("../services/aiClient");
const companion = require("../services/companion.service");
const { loadCompanionSetup, updateCompanionSetting, personaPromptLine, defaultVoiceId } = require("../services/companionSetting.service");
const { voiceFieldSchema, resolveVoiceSettings } = require("../utils/voiceSettings");

const router = express.Router();

const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1000;
/** 回复上限：人设要求 1～3 句，600 token 足够；再大就是模型跑偏，早点截断省钱也省前端排队 */
const MAX_REPLY_TOKENS = 600;

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(MAX_HISTORY),
  lang: z.enum(["zh", "en"]).optional(),
});

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

router.post("/chat", requireAuth, aiRateLimit({ max: 20, scope: "companion" }), async (req, res) => {
  const parsed = chatBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ message: "invalid messages", code: "VALIDATION_ERROR", details: parsed.error.issues });
  }
  if (!hasAiKey()) {
    return res.status(501).json({ message: "AI not configured", code: "AI_NOT_CONFIGURED" });
  }

  // 最后一条必须是用户说的话；助手历史只用来续上下文
  const history = parsed.data.messages;
  if (history[history.length - 1].role !== "user") {
    return res.status(400).json({ message: "last message must be from user", code: "VALIDATION_ERROR" });
  }

  // 装了人格 → 提示词多一段人设、每句的 TTS 指令带上人设的语调；没装 → 与从前逐字相同
  const setup = await loadCompanionSetup({ userId: req.user._id, req });
  const system = companion.buildSystemPrompt({
    name: companionName(),
    userName: req.user.displayName || req.user.username || "",
    lang: parsed.data.lang || "zh",
    personaLine: personaPromptLine(setup.persona),
  });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const abort = new AbortController();
  // ★ 必须监听 res 而不是 req 的 close：Node ≥16 里 IncomingMessage 的 'close' 在请求体读完就触发
  //   （不是连接断开），挂在 req 上会在第一句话还没生成时就把上游 abort 掉、所有事件静默丢弃 —— 表现为
  //   HTTP 200 + 空 body。res 的 'close' 在正常 end() 之后也会触发，所以要用 writableFinished 区分"客户端跑了"。
  res.on("close", () => {
    if (res.writableFinished) return;
    closed = true;
    abort.abort();
  });

  let index = 0;
  const plainParts = [];
  const splitter = companion.createSentenceSplitter((sentence) => {
    const p = companion.parseTags(sentence);
    if (!p.text) return; // 纯标签、没正文：不念也不演
    plainParts.push(p.text);
    send("sentence", { index: index++, ...p, tts: companion.ttsParamsFor(p.emotion, setup.voice.instruct) });
  });

  try {
    const stream = aiChatStream(
      [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))],
      { maxTokens: MAX_REPLY_TOKENS, temperature: 0.8, signal: abort.signal },
    );
    for await (const delta of stream) {
      if (closed) break;
      splitter.push(delta);
      send("token", { t: delta });
    }
    splitter.flush();
    send("done", { text: plainParts.join(" ") });
  } catch (e) {
    // 客户端主动断开时 abort 会抛错，这不是故障，静默收场即可；其余照实告诉前端并记日志
    if (!closed) {
      console.error("[companion] stream failed:", (e && e.message) || e);
      send("error", { message: "companion upstream failed" });
    }
  } finally {
    closed = true;
    res.end();
  }
});

module.exports = router;
