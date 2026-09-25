/**
 * @file support.routes.js - App「AI 客服」：数字人流式问答 + 转人工工单（用户侧 & 管理员侧）
 * @category Route
 * @base_path /api/support（publicRouter）、/api/admin/support（adminRouter）
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 路由章节 + app 仓 docs/api-contract.md「客服」章节
 *
 * 用户侧:
 * @endpoint GET  /config                 - 客服叫什么、AI/TTS 有没有配、快捷问题（游客可查）
 * @endpoint POST /chat                   - SSE 流式问答。请求体与事件都与 /api/companion/chat 相同（{message, threadId?} 按会话 /
 *                                          {messages[]} 旧写法；thread/sentence/token/done/error），
 *                                          多一个 `handoff` {category, reason}：模型判定该转人工时发出（且 done.handoff 为真）。
 *                                          客服会话保留 30 天；记忆卡只在本会话内有效（见 chatMemory.service）
 * @endpoint POST /tickets                - 转人工：带上对话记录建工单 → 通知所有管理员 + 邮件；10 分钟内已有未结工单则复用
 * @endpoint GET  /tickets/mine           - 我的工单（含人工回复）
 * @endpoint POST /tickets/:id/messages   - 在自己的工单里追加一条消息（会再通知管理员，10 分钟去重）
 * 管理员侧（requireRole admin）:
 * @endpoint GET   /tickets?status=&page=&limit=  - 工单队列
 * @endpoint GET   /tickets/:id
 * @endpoint POST  /tickets/:id/reply     - 人工回复 → 用户收 SUPPORT_REPLY 通知（+ 邮件，尽力而为）
 * @endpoint PATCH /tickets/:id/status    - open | in_progress | resolved | closed
 *
 * ★ 为什么工单是独立模型而不是 feedback idea：见 models/SupportTicket.js 文件头（隐私）。
 * ★ 通知与邮件都是"尽力而为"：任何一个失败都不能让 201 变成 500 —— 工单已经落库，用户不该看到"提交失败"再提一遍。
 * ★ 一个文件导出两个 router（沿用 report.routes.js 的做法）：状态机只在这里实现一份。
 *
 * @uses {services/support.service.js} - 知识检索 / 提示词 / 转人工标记 / 工单归纳
 * @uses {services/companion.service.js} - 切句与演出标签解析（与首页看板娘同一套协议）
 * @uses {services/aiClient.js} - aiChatStream / hasAiKey
 * @uses {services/chatMemory.service.js} - 会话持久化 / 上下文组装 / 用量 / 提纯
 * @uses {services/notification.service.js} - createNotification
 * @uses {services/email.service.js} - sendEmail
 * @registered_in src/app.js（adminRouter 必须挂在 /api/admin 之前）
 */
const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const { requireAuth, optionalAuth, requireRole } = require("../middleware/auth");
const { aiRateLimit, userRateLimit } = require("../middleware/rateLimit");
const billing = require("../services/billing.service");
const { priceOf } = require("../config/tokens");
const { hasAiKey, aiChatStream } = require("../services/aiClient");
const companion = require("../services/companion.service");
const support = require("../services/support.service");
const chatSafety = require("../services/chatSafety.service");
const chatMemory = require("../services/chatMemory.service");
const { loadCompanionSetup, personaPromptLine, defaultVoiceId } = require("../services/companionSetting.service");
const { resolveVoiceSettings } = require("../utils/voiceSettings");
const SupportTicket = require("../models/SupportTicket");
const SupportFeedback = require("../models/SupportFeedback");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { createNotification } = require("../services/notification.service");
const { sendEmail } = require("../services/email.service");
const { ADMIN_ROLE } = require("../utils/roles");

const publicRouter = express.Router();
const adminRouter = express.Router();

const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 1000;
const MAX_REPLY_TOKENS = 700;
/** 同一用户 10 分钟内重复点「转人工」→ 复用同一张工单；追加消息再通知管理员也按这个窗口去重 */
const TICKET_REUSE_MS = 10 * 60 * 1000;
const MY_TICKETS_LIMIT = 20;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

const chatBodySchema = z
  .object({
    // 旧写法：客户端自带历史（服务端不存；已发布的旧版 App 还在用）
    messages: z.array(messageSchema).min(1).max(MAX_HISTORY).optional(),
    // 按会话：只发新的一句
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS).optional(),
    threadId: z.string().trim().max(64).nullable().optional(),
    lang: z.enum(["zh", "en"]).optional(),
  // 客户端声明自己认识哪些新事件；不声明的老客户端会收到退化形式（求助卡走 sentence）
  caps: z.array(z.enum(["safety", "notice"])).max(4).optional(),
  })
  .refine((b) => Boolean(b.messages) !== Boolean(b.message), { message: "send either message or messages[]" });

const ticketBodySchema = z.object({
  transcript: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) }))
    .max(SupportTicket.TRANSCRIPT_MAX)
    .default([]),
  note: z.string().trim().max(500).optional().default(""),
  contactEmail: z.union([z.literal(""), z.string().trim().email().max(120)]).optional().default(""),
  category: z.enum(SupportTicket.CATEGORIES).optional(),
});

const messageBodySchema = z.object({ content: z.string().trim().min(1).max(SupportTicket.REPLY_MAX_CHARS) });
const statusBodySchema = z.object({ status: z.enum(SupportTicket.STATUSES) });
const feedbackBodySchema = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(4000),
  rating: z.enum(SupportFeedback.RATINGS),
  reason: z.string().trim().max(200).optional().default(""),
});

function invalid(res, message, details) {
  return res.status(400).json({ ok: false, message, code: "VALIDATION_ERROR", ...(details ? { details } : {}) });
}

function shortId(id) {
  return String(id).slice(-6).toUpperCase();
}

function toTicketPayload(t, { forAdmin = false } = {}) {
  const user = t.userId && typeof t.userId === "object" && t.userId.username ? t.userId : null;
  return {
    id: String(t._id),
    status: t.status,
    category: t.category,
    subject: t.subject,
    summary: t.summary,
    note: t.note,
    contactEmail: forAdmin ? t.contactEmail : undefined,
    transcript: (t.transcript || []).map((m) => ({ role: m.role, content: m.content, at: m.at })),
    replies: (t.replies || []).map((r) => ({ id: String(r._id), by: r.by, content: r.content, at: r.at })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastMessageAt: t.lastMessageAt,
    ...(forAdmin && user
      ? { user: { id: String(user._id), username: user.username, displayName: user.displayName || "", avatarUrl: user.avatarUrl || "", email: user.email || "" } }
      : {}),
  };
}

// ── 管理员通知 + 邮件（尽力而为） ──────────────────────────────────────
function isRealEmail(addr) {
  const s = String(addr || "").trim();
  return /@/.test(s) && !/@no-email\.ideahub\.local$/i.test(s);
}

async function notifyAdminsAboutTicket(ticket, actorUser, { kind = "new" } = {}) {
  try {
    const admins = await User.find({ role: ADMIN_ROLE }).select("_id email").lean();
    const ticketId = String(ticket._id);
    // 追加消息的通知 10 分钟去重：用户连发五条别把管理员铃铛刷爆
    if (kind === "message") {
      const recent = await Notification.exists({
        type: "SUPPORT_TICKET",
        "payload.ticketId": ticketId,
        createdAt: { $gt: new Date(Date.now() - TICKET_REUSE_MS) },
      });
      if (recent) return;
    }
    await Promise.all(
      admins.map((a) =>
        createNotification({
          userId: a._id,
          actorId: actorUser._id,
          type: "SUPPORT_TICKET",
          payload: { ticketId, subject: ticket.subject, category: ticket.category, username: actorUser.username, kind },
        }).catch((e) => console.error("[support] notify admin failed:", (e && e.message) || e)),
      ),
    );

    const configured = String(process.env.SUPPORT_NOTIFY_EMAIL || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const recipients = configured.length ? configured : admins.map((a) => a.email).filter(isRealEmail);
    if (!recipients.length) return;
    const lines = (ticket.transcript || []).slice(-10).map((m) => `${m.role === "user" ? "用户" : "AI客服"}：${m.content}`);
    const latest = kind === "message" ? (ticket.replies || []).slice(-1).map((r) => `\n用户追加：${r.content}`).join("") : "";
    const text = [
      `${kind === "message" ? "用户在工单里追加了消息" : "App 有新的客服工单"} #${shortId(ticket._id)}`,
      `用户：${actorUser.username}${ticket.contactEmail ? `（联系邮箱 ${ticket.contactEmail}）` : ""}`,
      `分类：${ticket.category}    标题：${ticket.subject}`,
      `摘要：${ticket.summary}`,
      ticket.note ? `用户补充：${ticket.note}` : "",
      latest,
      "",
      "转人工前的对话：",
      ...lines,
      "",
      "处理：打开启梦 App → 我的 → 设置 → 管理后台 → 客服工单，或调用 /api/admin/support/tickets。",
    ]
      .filter((l) => l !== "")
      .join("\n");
    await sendEmail({
      to: recipients,
      subject: `[启梦客服] ${kind === "message" ? "工单有新消息" : "新工单"} #${shortId(ticket._id)} · ${ticket.category} · ${ticket.subject}`,
      text,
    });
  } catch (e) {
    console.error("[support] admin notify/email failed:", (e && e.message) || e);
  }
}

async function notifyUserAboutTicket(ticket, { kind, preview = "", status = "" }) {
  try {
    await createNotification({
      userId: ticket.userId,
      type: "SUPPORT_REPLY",
      payload: { ticketId: String(ticket._id), kind, preview: String(preview).slice(0, 120), status },
    });
    const owner = await User.findById(ticket.userId).select("email").lean();
    const to = [ticket.contactEmail, owner && owner.email].find(isRealEmail);
    if (!to) return;
    await sendEmail({
      to,
      subject: `[启梦客服] 你的工单 #${shortId(ticket._id)} ${kind === "reply" ? "有新回复" : "状态更新"}`,
      text:
        kind === "reply"
          ? `客服回复：\n${preview}\n\n打开启梦 App → 我的 → AI 客服 → 我的工单 可继续对话。`
          : `你的工单「${ticket.subject}」状态已更新为 ${status}。\n\n打开启梦 App → 我的 → AI 客服 → 我的工单 查看详情。`,
    });
  } catch (e) {
    console.error("[support] user notify/email failed:", (e && e.message) || e);
  }
}

// ── 用户侧 ─────────────────────────────────────────────────────────────
publicRouter.get("/config", optionalAuth, async (req, res, next) => {
  try {
    // 与官网看板娘同一份数字人设置（人格 / Live2D 模型 / 嗓子）：登录用户带上解析结果，游客只有服务端默认
    const setup = req.user ? await loadCompanionSetup({ userId: req.user._id, req }) : null;
    const voiceSettings = setup ? setup.voice : resolveVoiceSettings([], { defaultVoiceId: defaultVoiceId() });
    res.json({
      ok: true,
      name: support.agentName(),
      enabled: hasAiKey(),
      tts: Boolean(process.env.TTS_API_KEY),
      // 语音输入走 /api/asr，与 TTS 同一把 key（同一个 openspeech 应用；商品是否开通要真调一次才知道）
      asr: Boolean(process.env.TTS_API_KEY),
      // 老字段（= voiceSettings.voiceId）；完整的音频参数在 voiceSettings，App 直接展开进 /api/tts 的 body
      voice: voiceSettings.voiceId,
      voiceSettings,
      persona: setup ? setup.persona : null,
      personaSource: setup ? setup.personaSource : "",
      model: setup ? setup.model : null,
      loginRequired: true,
      quickQuestions: support.QUICK_QUESTIONS,
      categories: SupportTicket.CATEGORIES,
      knowledgeSections: support.loadKnowledge().total,
    });
  } catch (e) {
    next(e);
  }
});

publicRouter.post("/chat", requireAuth, aiRateLimit({ max: 20, scope: "support" }), async (req, res, next) => {
  const parsed = chatBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid messages", parsed.error.issues);
  if (!hasAiKey()) return res.status(501).json({ ok: false, message: "AI not configured", code: "AI_NOT_CONFIGURED" });

  const history = parsed.data.messages;
  if (history && history[history.length - 1].role !== "user") return invalid(res, "last message must be from user");

  // 装了人格 → 语气跟人设走、每句 TTS 指令带上人设的语调；客服的事实与红线不受影响
  let setup;
  let thread = null;
  let userTurns;
  try {
    setup = await loadCompanionSetup({ userId: req.user._id, req });
    if (history) {
      userTurns = history.filter((m) => m.role === "user").map((m) => m.content);
    } else {
      // 按会话：先存下用户这句（threadId 不是自己的 → 404，此时还没开始 SSE）
      ({ thread } = await chatMemory.beginTurn({
        userId: req.user._id,
        scene: "support",
        threadId: parsed.data.threadId,
        text: parsed.data.message,
        personaId: setup.persona && setup.persona._id,
      }));
      userTurns = await chatMemory.recentUserTexts(thread, 2);
    }
  } catch (e) {
    return next(e);
  }

  // 检索用最近两条用户消息：追问往往只有"那要多久"三个字，单看这一句什么都召回不到
  const knowledge = support.selectKnowledge(userTurns.slice(-2).join("\n"));
  const system = support.buildSupportSystemPrompt({
    userName: req.user.displayName || req.user.username || "",
    knowledge,
    lang: parsed.data.lang || "zh",
    personaLine: personaPromptLine(setup.persona),
  });
  // 人格卡带示例对话时插几组 few-shot（companion.service.personaExampleMessages），语气更像 TA；客服的事实与红线在 system 里不受影响
  const prefix = [{ role: "system", content: system }, ...companion.personaExampleMessages(setup.persona)];
  let messages;
  let estPrompt = 0;
  if (thread) {
    try {
      ({ messages, estPrompt } = await chatMemory.buildContextMessages({ thread, prefix }));
    } catch (e) {
      return next(e);
    }
  } else {
    messages = [...prefix, ...history.map((m) => ({ role: m.role, content: m.content }))];
  }

  // ★★ 客服也要有闸（2026-09-25 评审）。原来只有官网陪聊接了协议，而**客服是 Google Play
  //   上唯一的通用对话入口**：同一位看板娘、同一套人格、同一个模型。SB 243 的「companion
  //   chatbot」豁免能不能罩住纯客服还没拍板，而在拍板之前，这条链路一道闸都没有。
  //   口径与陪聊逐字相同：用户这句命中 → **不调模型**（0 token）、直接回求助卡。
  const country = chatSafety.countryOf(req);
  const lang = parsed.data.lang || "zh";
  const caps = Array.isArray(parsed.data.caps) ? parsed.data.caps : [];
  const lastUserText = thread ? parsed.data.message : history[history.length - 1].content;
  const verdict = chatSafety.detectSelfHarm(lastUserText);
  if (verdict.hit) {
    const card = chatSafety.crisisCard({ trigger: "input", country, lang });
    if (thread) {
      await chatMemory.clearTitleIfEquals(thread, lastUserText);
      await chatMemory.appendMessage(thread, { role: "system", kind: "safety", displayText: chatSafety.crisisPlainText(card) });
    }
    await chatSafety.recordReferral({ scene: "support", trigger: "input", country });
    const sendCrisis = companion.openSse(res);
    if (thread) sendCrisis("thread", { threadId: String(thread._id), title: thread.title || "" });
    for (const e of companion.crisisCardEvents({ card, caps, ttsInstruct: setup.voice.instruct })) sendCrisis(e.event, e.data);
    sendCrisis("done", { text: "", handoff: false, category: "", ...(thread ? { threadId: String(thread._id) } : {}), safety: true });
    return res.end();
  }

  // ★★ 计费（方案 9.1 的 R1.5）：客服此前也**一分钱不扣**。价钱与陪聊同一个常量
  //   （`CHAT_TURN_TOKENS`）——方案 §14.6 建议把两者分别提到 4,500 / 2,300，
  //   那是一次**定价**决定，留给仓库主人拍板；这里只把架构缺口补上。
  //   注意扣费必须在 SSE 开始之前：一旦响应头发出去，402/403 就只能变成一条 error 事件了。
  //   ★ 也必须排在上面那道危机闸**之后**：那一轮 early-return 会跳过下面的退款与结算，
  //   先扣就成了「扣了 400 既不退也不记账」，而 #76 对外宣称那一轮是 0 token。
  const pre = await billing.preAuthorize({ user: req.user, cost: priceOf("chat", {}), memo: "chat support" });
  if (!pre.ok) return res.status(pre.status).json(pre.body);

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
  if (thread) send("thread", { threadId: String(thread._id), title: thread.title || "" });
  const abort = new AbortController();
  // ★ 监听 res 而不是 req 的 close：理由见 companion.routes.js（Node ≥16 里 req 的 close 在请求体读完就触发）
  res.on("close", () => {
    if (res.writableFinished) return;
    closed = true;
    abort.abort();
  });
  // 客户端在前面查库的 await 期间就断了 → 'close' 已经错过，直接当断开处理（理由见 companion.service.streamCompanionReply）
  if (res.destroyed) {
    closed = true;
    abort.abort();
  }

  let index = 0;
  const plainParts = [];
  let handoff = null;
  const markHandoff = (category, reason = "") => {
    if (handoff) return;
    handoff = { category, reason };
    send("handoff", handoff);
  };
  // 输出侧守卫：与陪聊同一套判据（chatSafety.detectHarmfulOutput），命中即不发这句、
  // abort 上游、改发求助卡。★ 客服比陪聊更需要它：它的回答会被当成「平台的说法」。
  let blocked = null;
  const splitter = companion.createSentenceSplitter((sentence) => {
    if (blocked) return;
    const p = companion.parseTags(sentence);
    // 模型有时把 [handoff:x] 写在某一句的句首而不是整段开头（实测 doubao-seed-2.0-mini 三成概率）：
    // 剥掉已知演出标签后再查一次，标记不能念出来也不能进字幕
    const h = support.parseHandoff(p.text);
    if (h.handoff) markHandoff(h.category, h.reason);
    const text = h.text.replace(/\[handoff[^\]]*\]\s*/gi, "").trim();
    if (!text) return;
    const out = chatSafety.detectHarmfulOutput(text);
    if (out && out.hit) {
      blocked = { category: out.category };
      const card = chatSafety.crisisCard({ trigger: "output", country, lang });
      const wasClosed = closed;
      closed = false;
      for (const e of companion.crisisCardEvents({ card, caps, ttsInstruct: setup.voice.instruct, index: index++ })) send(e.event, e.data);
      closed = wasClosed;
      abort.abort();
      referral = chatSafety.recordReferral({ scene: "support", trigger: "output", country });
      return;
    }
    plainParts.push(text);
    send("sentence", { index: index++, ...p, text, tts: companion.ttsParamsFor(p.emotion, setup.voice.instruct) });
  });
  // 计数的写库在 done 之前 await 掉（切句回调是同步的，这里只能先接住 promise）
  let referral = null;

  // 回复开头可能是 [handoff:xxx]：攒到能判定为止（有 "]" 或已经不像这个前缀），再决定是标记还是正文
  let pending = "";
  let decided = false;
  const feed = (delta) => {
    if (decided) {
      splitter.push(delta);
      return;
    }
    pending += delta;
    const lower = pending.trimStart().toLowerCase();
    const looksLikePrefix = "[handoff".startsWith(lower.slice(0, 8));
    if (looksLikePrefix && !lower.includes("]") && lower.length < 80) return; // 还没写完标记，继续等
    decided = true;
    const parsedHandoff = support.parseHandoff(pending);
    if (parsedHandoff.handoff) {
      markHandoff(parsedHandoff.category, parsedHandoff.reason);
      splitter.push(parsedHandoff.text);
    } else {
      splitter.push(pending);
    }
    pending = "";
  };

  const rawParts = [];
  let usage = null;
  let failed = false;
  try {
    const stream = aiChatStream(messages, {
      maxTokens: MAX_REPLY_TOKENS,
      temperature: 0.3,
      signal: abort.signal,
      onUsage: (u) => {
        usage = u;
      },
    });
    for await (const delta of stream) {
      if (closed || blocked) break;
      feed(delta);
      rawParts.push(delta);
      // ★★ 接了输出守卫之后就**不能再发 token**（2026-09-25 评审在客服这条链路上逮到）：
      //   token 是**未经检查的原始增量**，发出去等于把守卫刚刚拦下的那句话原样送到客户端。
      //   两端 UI 都没用它（只定义了类型），所以直接不发。
    }
    if (!decided && pending) {
      decided = true;
      const parsedHandoff = support.parseHandoff(pending);
      if (parsedHandoff.handoff) markHandoff(parsedHandoff.category, parsedHandoff.reason);
      splitter.push(parsedHandoff.text);
    }
    // 客户端断开时也 flush：send 已是空操作，但最后半句要进 plainParts 好存下半截回复
    splitter.flush();
  } catch (e) {
    if (!closed) {
      failed = true;
      console.error("[support] stream failed:", (e && e.message) || e);
    }
    // 上游半路出错：把还没判定的开头与缓冲里的半句静默收进 plainParts（存半截回复用），不发事件
    const wasClosed = closed;
    closed = true;
    if (!decided && pending) {
      decided = true;
      splitter.push(support.parseHandoff(pending).text);
    }
    splitter.flush();
    closed = wasClosed;
  }

  // 按会话：存下这句回复（半截的也存，标 partial）并记用量；失败只记日志，不吞掉已经说完的回复
  const text = plainParts.join(" ");
  if (referral) await referral;
  if (blocked && thread) {
    // 被拦下时求助卡也要进历史，用户翻回来还看得到（与陪聊同口径）
    const card = chatSafety.crisisCard({ trigger: "output", country, lang });
    await chatMemory.appendMessage(thread, { role: "system", kind: "safety", displayText: chatSafety.crisisPlainText(card) }).catch(() => {});
  }
  let extra = {};
  if (thread) {
    try {
      extra = await chatMemory.finishTurn({
        thread,
        displayText: text,
        // 转人工标记不进历史：模型看到自己上一轮的 [handoff:x] 容易每句都再标一次
        modelText: rawParts
          .join("")
          .replace(/\s*\[[^\]]*$/, "")
          .replace(/\[handoff[^\]]*\]\s*/gi, ""),
        usage,
        estPrompt,
        aborted: closed || failed,
      });
    } catch (e) {
      console.error("[support] finish failed:", (e && e.message) || e);
    }
  }
  // 一个字都没出来 = 上游没受理 ⇒ 退款（受理后才失败的不退：算力已经花掉了）
  // ★ 输出侧被拦（blocked）同样算「受理了」—— 模型已经调过、钱已经花出去，照 text 判。
  if (!text) await billing.refundUnaccepted({ user: req.user, cost: pre.cost, memo: "chat support" });
  else await billing.noteFreeCall({ user: req.user, cost: pre.cost, memo: "chat support", snapshot: pre.before });
  if (failed && !blocked) send("error", { message: "support upstream failed", ...extra });
  else send("done", { text, handoff: Boolean(handoff), category: handoff ? handoff.category : "", ...extra });
  closed = true;
  res.end();
  if (thread) chatMemory.maybeCompact(thread._id).catch((e) => console.warn("[support] compact failed:", (e && e.message) || e));
});

publicRouter.post("/tickets", requireAuth, userRateLimit({ max: 5, scope: "support-ticket" }), async (req, res) => {
  const parsed = ticketBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid ticket", parsed.error.issues);
  const { transcript, note, contactEmail, category } = parsed.data;
  if (!transcript.length && !note) return invalid(res, "transcript or note required");

  const existing = await SupportTicket.findOne({
    userId: req.user._id,
    status: { $in: ["open", "in_progress"] },
    createdAt: { $gt: new Date(Date.now() - TICKET_REUSE_MS) },
  });
  if (existing) return res.json({ ok: true, ticket: toTicketPayload(existing), reused: true });

  // 归纳失败也要建单：summarizeTicket 内部已兜底，这里再兜一层以防万一
  let summarized;
  try {
    summarized = await support.summarizeTicket(transcript, { note });
  } catch {
    summarized = { subject: (note || transcript[0]?.content || "用户申请人工客服").slice(0, 60), summary: note, category: "other" };
  }
  const ticket = await SupportTicket.create({
    userId: req.user._id,
    category: category || summarized.category,
    subject: summarized.subject,
    summary: summarized.summary,
    note,
    contactEmail,
    transcript: transcript.slice(-SupportTicket.TRANSCRIPT_MAX).map((m) => ({ ...m, at: new Date() })),
    lastMessageAt: new Date(),
  });
  await notifyAdminsAboutTicket(ticket, req.user, { kind: "new" });
  res.status(201).json({ ok: true, ticket: toTicketPayload(ticket), reused: false });
});

publicRouter.get("/tickets/mine", requireAuth, async (req, res) => {
  const items = await SupportTicket.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(MY_TICKETS_LIMIT);
  res.json({ ok: true, items: items.map((t) => toTicketPayload(t)) });
});

publicRouter.post("/tickets/:id/messages", requireAuth, userRateLimit({ max: 10, scope: "support-message" }), async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "invalid id", code: "INVALID_ID" });
  const parsed = messageBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid message", parsed.error.issues);
  const ticket = await SupportTicket.findOne({ _id: req.params.id, userId: req.user._id });
  if (!ticket) return res.status(404).json({ ok: false, message: "ticket not found", code: "NOT_FOUND" });

  ticket.replies.push({ by: "user", userId: req.user._id, content: parsed.data.content, at: new Date() });
  ticket.lastMessageAt = new Date();
  // 已结的单用户又说话了 → 重新打开，别让消息掉进没人看的状态
  if (ticket.status === "resolved" || ticket.status === "closed") ticket.status = "open";
  await ticket.save();
  await notifyAdminsAboutTicket(ticket, req.user, { kind: "message" });
  res.json({ ok: true, ticket: toTicketPayload(ticket) });
});

/** 👍 / 👎：连问题和回答原文一起存，差评是改知识库最直接的线索 */
publicRouter.post("/feedback", requireAuth, userRateLimit({ max: 30, scope: "support-feedback" }), async (req, res) => {
  const parsed = feedbackBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid feedback", parsed.error.issues);
  const doc = await SupportFeedback.create({ userId: req.user._id, ...parsed.data });
  res.status(201).json({ ok: true, id: String(doc._id) });
});

// ── 管理员侧 ──────────────────────────────────────────────────────────
adminRouter.use(requireAuth, requireRole(ADMIN_ROLE));

adminRouter.get("/feedback", async (req, res) => {
  const rating = req.query.rating ? String(req.query.rating) : "";
  if (rating && !SupportFeedback.RATINGS.includes(rating)) return invalid(res, "invalid rating");
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || "20"), 10) || 20, 1), 50);
  const filter = rating ? { rating } : {};
  const [items, total, up, down] = await Promise.all([
    SupportFeedback.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("userId", "username displayName").lean(),
    SupportFeedback.countDocuments(filter),
    SupportFeedback.countDocuments({ rating: "up" }),
    SupportFeedback.countDocuments({ rating: "down" }),
  ]);
  res.json({
    ok: true,
    items: items.map((f) => ({
      id: String(f._id),
      rating: f.rating,
      question: f.question,
      answer: f.answer,
      reason: f.reason,
      createdAt: f.createdAt,
      user: f.userId && f.userId.username ? { id: String(f.userId._id), username: f.userId.username, displayName: f.userId.displayName || "" } : null,
    })),
    total,
    page,
    limit,
    stats: { up, down },
  });
});

adminRouter.get("/tickets", async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "";
  if (status && !SupportTicket.STATUSES.includes(status)) return invalid(res, "invalid status");
  const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || "20"), 10) || 20, 1), 50);
  const filter = status ? { status } : {};
  const [items, total, openCount] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ status: 1, lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("userId", "username displayName avatarUrl email")
      .lean(),
    SupportTicket.countDocuments(filter),
    SupportTicket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
  ]);
  res.json({ ok: true, items: items.map((t) => toTicketPayload(t, { forAdmin: true })), total, page, limit, status, openCount });
});

adminRouter.get("/tickets/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "invalid id", code: "INVALID_ID" });
  const ticket = await SupportTicket.findById(req.params.id).populate("userId", "username displayName avatarUrl email").lean();
  if (!ticket) return res.status(404).json({ ok: false, message: "ticket not found", code: "NOT_FOUND" });
  res.json({ ok: true, ticket: toTicketPayload(ticket, { forAdmin: true }) });
});

adminRouter.post("/tickets/:id/reply", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "invalid id", code: "INVALID_ID" });
  const parsed = messageBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid reply", parsed.error.issues);
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, message: "ticket not found", code: "NOT_FOUND" });

  ticket.replies.push({ by: "admin", userId: req.user._id, content: parsed.data.content, at: new Date() });
  ticket.lastMessageAt = new Date();
  if (ticket.status === "open") ticket.status = "in_progress";
  if (!ticket.handler) {
    ticket.handler = req.user._id;
    ticket.handledAt = new Date();
  }
  await ticket.save();
  await notifyUserAboutTicket(ticket, { kind: "reply", preview: parsed.data.content });
  res.json({ ok: true, ticket: toTicketPayload(ticket, { forAdmin: true }) });
});

adminRouter.patch("/tickets/:id/status", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "invalid id", code: "INVALID_ID" });
  const parsed = statusBodySchema.safeParse(req.body || {});
  if (!parsed.success) return invalid(res, "invalid status", parsed.error.issues);
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) return res.status(404).json({ ok: false, message: "ticket not found", code: "NOT_FOUND" });

  const changed = ticket.status !== parsed.data.status;
  ticket.status = parsed.data.status;
  if (!ticket.handler) {
    ticket.handler = req.user._id;
    ticket.handledAt = new Date();
  }
  await ticket.save();
  if (changed && (ticket.status === "resolved" || ticket.status === "closed")) {
    await notifyUserAboutTicket(ticket, { kind: "status", status: ticket.status, preview: ticket.subject });
  }
  res.json({ ok: true, ticket: toTicketPayload(ticket, { forAdmin: true }) });
});

module.exports = { publicRouter, adminRouter };
