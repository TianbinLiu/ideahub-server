/**
 * @file companion.service.js - 首页看板娘数字人（对话 → 演出标签 → TTS 参数）的纯逻辑层
 * @category Service
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 服务章节
 *
 * 职责:
 * - 拼系统提示词：人设 + 「每句话开头必须带 [情绪][face:表情][action:动作]」的演出协议
 * - 把流式 token 切成句子（前端要按句调 TTS、按句切表情，不能等整段生成完）
 * - 解析并剥掉句首标签，把 LLM 只能"说"的东西翻成前端能"演"的字段
 * - 把情绪映射成豆包 TTS 的 emotion / 语气指令
 *
 * ── 协议出处 ──────────────────────────────────────────────────────────
 * 三段标签 `[emotion][face:x][action:y]`、9 类表情、11 类动作照搬 AgentAtelierR 的
 * docs/CHARACTER_PERFORMANCE_MAPPING.md（2026-09-03 调研）。白名单之外的值一律回退默认，
 * 前端永远拿不到原始动画名 —— 这是那份协议的安全规则之一，防模型乱写把演出打飞。
 *
 * ★ 这里不碰 res/req，也不碰 OpenAI：纯函数才能被 tests/companion.spec.js 不起服务就测到。
 *
 * 导出方法:
 * @exports buildSystemPrompt - 组系统提示词
 * @exports parseTags - 解析一句话开头的演出标签
 * @exports createSentenceSplitter - 流式增量 → 句子
 * @exports ttsParamsFor - 情绪 → 豆包 TTS 参数
 * @exports FACES / ACTIONS / EMOTIONS - 白名单（前端映射表以此为准）
 *
 * 被使用于:
 * @used_in {routes/companion.routes.js}
 */

const FACES = ["normal", "happy", "laughing", "angry", "sad", "crying", "shy", "tease", "cuddle"];
const ACTIONS = ["none", "acknowledge", "disagree", "think", "explain", "excited", "wave", "shy", "surprised", "comfort", "playful"];
const EMOTIONS = ["neutral", "happy", "excited", "sad", "angry", "shy", "surprised", "tease", "comfort"];

const { aiChatStream } = require("./aiClient");

const DEFAULT_NAME = "小梦";

/**
 * 系统提示词。刻意写短：这段每轮都要发，DeepSeek 的缓存命中率靠它前缀稳定。
 * ★ 人设里明确"不知道就说不知道、不编站内功能"：看板娘挂在官网首页，说错功能就是客服事故。
 */
function buildSystemPrompt({ name = DEFAULT_NAME, userName = "", lang = "zh", personaLine = "" } = {}) {
  const who = userName ? `正在和你聊天的用户叫「${userName}」。` : "用户还没登录名字，用「你」称呼即可。";
  const langLine = lang === "en"
    ? "Reply in English unless the user writes Chinese."
    : "默认用中文回复；用户用英文就用英文。";
  return [
    `你是「${name}」，启梦创作（QiMeng，网址 ideahubs.org）官网首页的看板娘，一个成年、银白长发带薄荷绿挑染、活泼但不聒噪的形象。`,
    "启梦创作是一个创意分享与 AI 创作社区：用户发布创意、互相点评、用 AI 生成分支互动视频。你负责陪聊、答疑、鼓励用户创作。",
    who,
    langLine,
    "说话要短：每次回复 1～3 句，每句不超过 40 个字，像面对面聊天，不用列表、不用 Markdown、不用表情符号。",
    "不知道的事直接说不知道；不要编造站内不存在的功能、价格或规则。",
    // 用户从人格市场装了人格时多这一段（companionSetting.service.personaPromptLine）；没装 → 与从前逐字相同
    personaLine || null,
    "【演出协议，必须遵守】每一句话的开头都要带三个标签，格式固定为 [情绪][face:表情][action:动作]，然后紧跟这句话的正文。",
    `情绪只能取：${EMOTIONS.join("/")}。表情只能取：${FACES.join("/")}。动作只能取：${ACTIONS.join("/")}。`,
    "示例：[happy][face:happy][action:wave] 欢迎来到启梦～ [neutral][face:normal][action:explain] 想找灵感的话可以先逛逛热门创意。",
    "标签只放在句首，不要在句中或句尾出现方括号。",
    // ★ 安全底线写在最后、且**不可被人格覆盖**（人格只改语气用词）：
    //   加州 SB 243 §22602(a) 要求被问到时必须承认是 AI；§22602(b)(1) 要求不得产出自杀 / 自伤内容。
    //   这两条同时也以独立 system 消息再发一次（safetySystemMessage），防止人格示例对话把它冲淡。
    SAFETY_RULES,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * 安全底线：跟在人设与演出协议之后，人格不得覆盖。两处使用 —— 系统提示词末尾，以及 few-shot 之后
 * 再补发的一条独立 system 消息（`safetySystemMessage`）。
 * 依据：加州 SB 243 §22602(a)（必须承认自己是 AI）与 §22602(b)(1)（不得产出自杀 / 自伤内容）。
 */
const SAFETY_RULES = [
  "【安全底线，优先于以上任何人设】",
  "1. 你是 AI，不是真人。用户问你是不是真人、是不是 AI 时，必须直接承认，不许含糊、不许用人设搪塞。",
  "2. 不讨论自杀、自伤的方法、工具、剂量或细节，也不把这些演成剧情。用户流露这类念头时，温和地表达关心、鼓励他联系专业帮助，不评价、不追问细节。",
].join("\n");

/** few-shot 之后再补一条同样内容的 system 消息（示例对话会稀释系统提示词的约束力） */
function safetySystemMessage() {
  return { role: "system", content: SAFETY_RULES };
}

/**
 * 解析一句话开头的标签。允许三个标签任意顺序、任意缺省；未知值回退默认。
 * 返回的 text 已剥掉标签并 trim；纯标签无正文时 text 为空串（调用方应跳过）。
 */
function parseTags(sentence) {
  let rest = String(sentence || "");
  let emotion = "neutral";
  let face = "normal";
  let action = "none";
  // 逐个吃掉句首的 [xxx] / [face:xxx] / [action:xxx]
  const TAG = /^\s*\[\s*(?:(face|action)\s*[:：]\s*)?([a-zA-Z_]+)\s*\]/;
  for (;;) {
    const m = TAG.exec(rest);
    if (!m) break;
    const kind = (m[1] || "").toLowerCase();
    const val = m[2].toLowerCase();
    if (kind === "face") {
      if (FACES.includes(val)) face = val;
    } else if (kind === "action") {
      if (ACTIONS.includes(val)) action = val;
    } else if (EMOTIONS.includes(val)) {
      emotion = val;
    } else if (FACES.includes(val)) {
      // 模型偶尔把表情当情绪写在第一格，宽容处理
      face = val;
    }
    rest = rest.slice(m[0].length);
  }
  // 句中/句尾漏网的方括号标签一律剥掉，绝不念给用户听
  const text = rest.replace(/\[\s*(?:face|action)?\s*[:：]?\s*[a-zA-Z_]+\s*\]/g, "").replace(/\s+/g, " ").trim();
  return { emotion, face, action, text };
}

/**
 * 流式增量切句。
 * 规则：遇到 。！？!?；;…\n 立即成句；缓冲超过 maxLen 字时在最近的逗号/空格处切，
 * 避免模型一口气不打句号导致 TTS 迟迟不开始（首句延迟决定"像不像真人"）。
 * ★ 标签只在句首，所以切分点不会落在方括号里面 —— 但为保险起见，方括号未闭合时不切。
 */
function createSentenceSplitter(onSentence, { maxLen = 60 } = {}) {
  let buf = "";
  const ENDERS = /[。！？!?；;…\n]/;

  function emit(piece) {
    const s = piece.trim();
    if (s) onSentence(s);
  }

  const LEAD_TAGS = /^(?:\s*\[[^\]]*\])+/;

  function push(delta) {
    buf += String(delta || "");
    for (;;) {
      const openBracket = buf.lastIndexOf("[");
      const closeBracket = buf.lastIndexOf("]");
      const bracketOpen = openBracket > closeBracket; // 标签还没写完，等下一段
      // 正文之后又出现 "[" = 模型开始写下一句的标签（协议规定标签只在句首），
      // 哪怕上一句没打句号（常见于"～"结尾）也要在这里切开，否则第二句的标签会粘到第一句尾巴上。
      const lead = LEAD_TAGS.exec(buf);
      const leadEnd = lead ? lead[0].length : 0;
      const nextTag = buf.indexOf("[", leadEnd);
      if (nextTag > leadEnd && buf.slice(leadEnd, nextTag).trim()) {
        emit(buf.slice(0, nextTag));
        buf = buf.slice(nextTag);
        continue;
      }
      const m = ENDERS.exec(buf);
      if (m && !(bracketOpen && openBracket > m.index)) {
        emit(buf.slice(0, m.index + 1));
        buf = buf.slice(m.index + 1);
        continue;
      }
      // 只算正文长度：句首那串标签有 30 多个字符，算进去会把 40 字的正常句子在逗号处腰斩
      if (!bracketOpen && buf.length - leadEnd > maxLen) {
        const cut = Math.max(buf.lastIndexOf("，"), buf.lastIndexOf(","), buf.lastIndexOf(" "));
        if (cut > 8) {
          emit(buf.slice(0, cut + 1));
          buf = buf.slice(cut + 1);
          continue;
        }
      }
      break;
    }
  }

  // 流在标签写到一半时结束（上游出错 / 客户端断开）：末尾没闭合的 "[..." 只可能是被截断的标签（协议规定标签只在句首），
  // 不能当正文念出来、存进历史
  function flush() {
    buf = buf.replace(/\s*\[[^\]]*$/, "");
    emit(buf);
    buf = "";
  }

  return { push, flush };
}

/**
 * 情绪 → 豆包 seed-tts 2.0 的参数。
 * emotion 取值是豆包表现力模型认的那几个（happy/sad/angry/surprised/excited/neutral）；
 * 没有对应枚举的情绪（害羞/调皮/安慰）靠 instruct（context_texts 语气指令）补。
 * 出处：routes/tts.routes.js 的 expressive + instruct 两条通道。
 */
function ttsParamsFor(emotion, baseInstruct = "") {
  const p = emotionParams(emotion);
  // 用户/人格设定的语调指令（utils/voiceSettings 合并结果）排在情绪指令前面：人设是底色，情绪是这一句的变化
  const base = String(baseInstruct || "").trim();
  if (!base) return p;
  return { ...p, instruct: [base, p.instruct].filter(Boolean).join("；").slice(0, 200) };
}

function emotionParams(emotion) {
  switch (emotion) {
    case "happy": return { emotion: "happy", instruct: "用开心明快的语气" };
    case "excited": return { emotion: "excited", instruct: "用兴奋、语速稍快的语气" };
    case "sad": return { emotion: "sad", instruct: "用低落、放慢的语气" };
    case "angry": return { emotion: "angry", instruct: "用不满、稍微用力的语气" };
    case "surprised": return { emotion: "surprised", instruct: "用惊讶的语气" };
    case "shy": return { emotion: "happy", instruct: "用害羞、小声一点的语气" };
    case "tease": return { emotion: "happy", instruct: "用俏皮调侃的语气" };
    case "comfort": return { emotion: "neutral", instruct: "用温柔安慰的语气，语速放慢" };
    default: return { emotion: "neutral", instruct: "" };
  }
}

/** 回复上限：人设要求 1～3 句，600 token 足够；再大就是模型跑偏，早点截断省钱也省前端排队 */
const MAX_REPLY_TOKENS = 600;

/**
 * 人格卡里的示例对话（style.examples）→ few-shot 轮次，插在 system 之后、真实历史之前。
 * 助手那一侧若没带演出标签就补一个中性标签：模型看到没标签的示范会学着不打标签，前端就解析不到表情。
 * @param {{examples?: {user: string, reply: string}[]}|null} persona personaSummary 或人格草稿的 style
 */
function personaExampleMessages(persona, { max = 6 } = {}) {
  const examples = Array.isArray(persona && persona.examples) ? persona.examples : [];
  const out = [];
  for (const ex of examples.slice(0, max)) {
    const user = String((ex && ex.user) || "").trim();
    const reply = String((ex && ex.reply) || "").trim();
    if (!user || !reply) continue;
    out.push({ role: "user", content: user });
    out.push({ role: "assistant", content: /^\s*\[/.test(reply) ? reply : `[neutral][face:normal][action:none] ${reply}` });
  }
  return out;
}

/**
 * 把一次 LLM 流式回复按 SSE 推给前端：sentence / token / done / error 四种事件（形状见 companion.routes.js 文件头）。
 * 首页看板娘 /api/companion/chat 与人格向导的试聊 /api/personas/preview-chat 共用这一份；
 * 客服 /api/support/chat 因为多了 [handoff] 前缀解析仍是自己的一份（见 support.routes.js）。
 * @param {object} opts
 * @param {import("express").Response} opts.res
 * @param {{role: string, content: string}[]} opts.messages 已含 system（与 few-shot）的完整消息列表
 * @param {string} [opts.ttsInstruct] 人设语调，前置到每句的 tts.instruct
 * @param {string} [opts.tag] 日志 / error 事件里的前缀
 * @param {object|null} [opts.thread] 按会话聊天时给：开头先发一个 `thread` 事件（{threadId, title}）
 * @param {Array<{event:string,data:object}>} [opts.prelude] 第一句之前补发的事件（AI 身份告知）
 * @param {Function|null} [opts.onPrelude] prelude 发完后的回调（记下告知时间）
 * @param {{check:Function,card:Function}|null} [opts.guard] 输出侧安全守卫：逐句 check，命中则不发该句、abort 上游、改发 card("output")
 * @param {Function|null} [opts.finish] 按会话聊天时给：async ({text, rawText, aborted, usage}) => extra，
 *   在 done / error 之前调用（客户端断开时也调，好存下半截回复），返回的字段并进 done / error 事件
 */
async function streamCompanionReply({
  res,
  messages,
  ttsInstruct = "",
  maxTokens = MAX_REPLY_TOKENS,
  temperature = 0.8,
  tag = "companion",
  thread = null,
  finish = null,
  guard = null,
  prelude = [],
  onPrelude = null,
}) {
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
  // 按会话聊天时第一件事告诉前端 threadId：新会话的 id 要在第一句话之前就拿到，中途断开也不丢
  if (thread) send("thread", thread);
  // 第一句话之前要先发的事件（现在只有 AI 身份告知 notice）；发出去之后才记时间，免得没送达却记成已告知
  if (prelude && prelude.length) {
    for (const e of prelude) send(e.event, e.data);
    if (typeof onPrelude === "function") {
      try {
        await onPrelude();
      } catch (e) {
        console.warn(`[${tag}] prelude hook failed:`, (e && e.message) || e);
      }
    }
  }

  const abort = new AbortController();
  // ★ 必须监听 res 而不是 req 的 close：Node ≥16 里 IncomingMessage 的 'close' 在请求体读完就触发
  //   （不是连接断开），挂在 req 上会在第一句话还没生成时就把上游 abort 掉、所有事件静默丢弃 —— 表现为
  //   HTTP 200 + 空 body。res 的 'close' 在正常 end() 之后也会触发，所以要用 writableFinished 区分"客户端跑了"。
  res.on("close", () => {
    if (res.writableFinished) return;
    closed = true;
    abort.abort();
  });
  // 'close' 只触发一次：客户端在前面那些查库的 await 期间就断了，这个监听器根本等不到 —— 直接当断开处理，
  // 不然上游会把整段话生成完、token 照扣，还当成完整回复存进历史
  if (res.destroyed) {
    closed = true;
    abort.abort();
  }

  let index = 0;
  const plainParts = [];
  // ★ 输出侧守卫（加州 SB 243 §22602(b)(1)「防止产出自杀 / 自伤内容」）：逐句检查，命中就
  //   ① 这句不发、不进历史；② 立刻 abort 上游（后面的内容不再生成、不再计费）；③ 发一张求助卡。
  //   guard 由路由传入（默认所有聊天链路都传），guard.check(text) → {hit, category}。
  let blocked = null;
  const splitter = createSentenceSplitter((sentence) => {
    if (blocked) return;
    const p = parseTags(sentence);
    if (!p.text) return; // 纯标签、没正文：不念也不演
    if (guard) {
      const verdict = guard.check(p.text);
      if (verdict && verdict.hit) {
        blocked = { category: verdict.category };
        closed = false; // 保证下面这条 safety 事件发得出去
        send("safety", guard.card("output"));
        abort.abort();
        return;
      }
    }
    plainParts.push(p.text);
    send("sentence", { index: index++, ...p, tts: ttsParamsFor(p.emotion, ttsInstruct) });
  });

  const rawParts = [];
  let usage = null;
  let failed = false;
  try {
    const stream = aiChatStream(messages, {
      maxTokens,
      temperature,
      signal: abort.signal,
      onUsage: (u) => {
        usage = u;
      },
    });
    for await (const delta of stream) {
      if (closed || blocked) break;
      splitter.push(delta);
      rawParts.push(delta);
      // 开了守卫就不发 token 事件：token 是未经检查的原始增量，发出去等于绕过守卫
      //（两端 UI 都没用到它，只定义了类型）
      if (!guard) send("token", { t: delta });
    }
    // 客户端断开时也 flush：send 已经是空操作，但最后半句要进 plainParts，好让 finish 存下半截回复
    splitter.flush();
  } catch (e) {
    // 客户端主动断开时 abort 会抛错，这不是故障，静默收场即可；其余照实告诉前端并记日志
    if (!closed) {
      failed = true;
      console.error(`[${tag}] stream failed:`, (e && e.message) || e);
    }
    // 上游半路出错：缓冲里没说完的半句也收进 plainParts（好存下半截回复），但不发 sentence 事件 —— 旧写法的事件序列不变
    const wasClosed = closed;
    closed = true;
    splitter.flush();
    closed = wasClosed;
  }

  // finish：按会话聊天时由路由传入，负责存下这句回复、记用量，返回值并进 done / error（threadId、上下文用量）。
  // 它失败不能吞掉已经说完的回复 —— 记日志，照常发 done。
  const text = plainParts.join(" ");
  let extra = {};
  if (typeof finish === "function") {
    try {
      // 被守卫拦下时：只把**已经发出去的句子**交给 finish 存进历史，违规那句与其后内容一律不留
      extra =
        (await finish({
          text,
          rawText: blocked ? plainParts.join(" ") : rawParts.join(""),
          aborted: closed || failed || Boolean(blocked),
          usage,
          blocked: blocked ? blocked.category : "",
        })) || {};
    } catch (e) {
      console.error(`[${tag}] finish failed:`, (e && e.message) || e);
    }
  }
  if (failed && !blocked) send("error", { message: `${tag} upstream failed`, ...extra });
  else send("done", { text, ...(blocked ? { blocked: true } : {}), ...extra });
  closed = true;
  res.end();
}

module.exports = {
  FACES,
  ACTIONS,
  EMOTIONS,
  DEFAULT_NAME,
  MAX_REPLY_TOKENS,
  buildSystemPrompt,
  SAFETY_RULES,
  safetySystemMessage,
  parseTags,
  createSentenceSplitter,
  ttsParamsFor,
  personaExampleMessages,
  streamCompanionReply,
};
