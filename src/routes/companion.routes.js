/**
 * @file companion.routes.js - 首页看板娘数字人：配置探测 + SSE 流式对话
 * @category Route
 * @base_path /api/companion
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节
 *
 * API端点:
 * @endpoint GET  /config - 这台服务器有没有配 AI/TTS、看板娘叫什么（游客可查，决定前端画不画对话框）
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

function companionName() {
  return String(process.env.COMPANION_NAME || "").trim() || companion.DEFAULT_NAME;
}

router.get("/config", optionalAuth, (req, res) => {
  res.json({
    ok: true,
    name: companionName(),
    enabled: hasAiKey(),
    tts: Boolean(process.env.TTS_API_KEY),
    // 豆包音色 id；不配就用 tts.routes.js 的默认音色。留给运维换嗓子用，不进代码。
    voice: String(process.env.COMPANION_TTS_VOICE || "").trim(),
    loginRequired: true,
  });
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

  const system = companion.buildSystemPrompt({
    name: companionName(),
    userName: req.user.displayName || req.user.username || "",
    lang: parsed.data.lang || "zh",
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
  req.on("close", () => {
    closed = true;
    abort.abort();
  });

  let index = 0;
  const plainParts = [];
  const splitter = companion.createSentenceSplitter((sentence) => {
    const p = companion.parseTags(sentence);
    if (!p.text) return; // 纯标签、没正文：不念也不演
    plainParts.push(p.text);
    send("sentence", { index: index++, ...p, tts: companion.ttsParamsFor(p.emotion) });
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
