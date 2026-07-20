// src/services/personaAi.service.js
// 人格 AI 服务：从用户上传的聊天文本里提炼「人格」草稿（供情景编辑器现场生成后创建+绑定）。
// 只负责生成【草稿】不落库 —— 创建仍走 POST /api/personas 的既有链路（校验/归属/shared 由它管），
// 这样用户取消时不会留下孤儿人格，AI 输出也天然过一遍 createPersona 的归一。
const { hasAiKey, aiComplete } = require("./aiClient");

function requireKey() {
  if (!hasAiKey()) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }
}

function parseJsonObject(text) {
  const raw = String(text || "");
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * 从聊天文本提炼人格草稿。
 * @param {object} opts
 * @param {string} opts.chatText 用户粘贴的聊天记录/发言合集（已由 schema 限长）
 * @param {string} [opts.hint] 可选提示：想提炼谁/什么风格（如「提炼里面的组长」）
 * @returns {Promise<{name,description,coverEmoji,tags,style:{summary,catchphrases,stanceHint},model}>}
 */
async function generatePersonaFromChat({ chatText, hint }) {
  requireKey();

  const hintLine = String(hint || "").trim();
  const prompt = [
    "你是一个「说话风格分析师」。下面是一段聊天记录/发言合集，请从中提炼出一个鲜明的「人格」，",
    "供 AI 在聊天情景里扮演该风格的角色。",
    hintLine ? `提炼要求：${hintLine}` : "若记录里有多个说话人，选风格最鲜明的那一位。",
    "",
    "只返回 JSON（不要 markdown、不要解释），字段：",
    "{",
    '  "name": "人格名（6~12 字，概括风格气质，别用真名）",',
    '  "description": "一句话简介：适合什么场合、什么风格（≤60 字）",',
    '  "coverEmoji": "一个最贴合该人格的 emoji",',
    '  "tags": ["3~6 个检索标签：身份类（职场/上司/同事/客服…）+ 风格类（毒舌/热心/高冷…）"],',
    '  "summary": "一段话点评该人格的说话风格与气质（80~200 字，具体到用词/句式/情绪习惯）",',
    '  "catchphrases": ["从原文提炼的口头禅/高频短语，3~8 条，尽量保留原话"],',
    '  "stanceHint": "该人格的立场/倾向/待人方式提示（≤60 字，可空字符串）"',
    "}",
    "",
    "要求：",
    "- 一切以【原文证据】为准：口头禅必须真的在原文出现过或高度贴近，不要编造。",
    "- summary 要能指导 AI 模仿：写「怎么说话」（句长/语气词/标点习惯/怼人还是打圆场），不写内容摘要。",
    "- 聊天记录里的昵称/隐私信息（手机号、地址等）不得进入任何字段。",
    "",
    "聊天记录：",
    "-----",
    String(chatText || "").slice(0, 12000),
    "-----",
  ].join("\n");

  const { text, model } = await aiComplete(prompt);

  const data = parseJsonObject(text);
  if (!data || !String(data.name || "").trim()) {
    const err = new Error("AI 返回的人格无法解析，请重试");
    err.status = 502;
    throw err;
  }

  return {
    name: String(data.name || "").trim().slice(0, 120),
    description: String(data.description || "").trim().slice(0, 1000),
    coverEmoji: String(data.coverEmoji || "🎭").trim().slice(0, 8),
    tags: Array.isArray(data.tags) ? data.tags.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 12) : [],
    style: {
      summary: String(data.summary || "").trim().slice(0, 2000),
      // 每条 slice(0,120) 必须与 persona.schemas.js styleBody 的 max(120) 对齐：
      // zod 是【拒绝】不是截断，草稿里混进一条超长口头禅会让「创建并绑定」直接 400 死胡同
      catchphrases: Array.isArray(data.catchphrases)
        ? data.catchphrases.map((x) => String(x || "").trim().slice(0, 120)).filter(Boolean).slice(0, 12)
        : [],
      stats: [],
      stanceHint: String(data.stanceHint || "").trim().slice(0, 500),
    },
    model,
  };
}

module.exports = { generatePersonaFromChat };
