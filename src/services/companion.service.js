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
    `你是「${name}」，启梦创作（QiMeng，网址 ideahubs.org）官网首页的看板娘，一个 16 岁左右、银白长发带薄荷绿挑染、活泼但不聒噪的少女形象。`,
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
  ]
    .filter((line) => line !== null)
    .join("\n");
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

  function flush() {
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

module.exports = { FACES, ACTIONS, EMOTIONS, DEFAULT_NAME, buildSystemPrompt, parseTags, createSentenceSplitter, ttsParamsFor };
