// src/services/arenaSuggest.service.js
//
// 卢本伟广场 · 浏览器插件后端：为用户当前的评论输入实时生成三条不同风格的发言方案。
//
// 复用项目既有的 AI 调用 + STRICT-JSON + 解析兜底 的模式（见 services/aiReview.service.js）。
// 统一经由 services/aiClient.js 出口（provider 由 env 驱动）。无 API key 时抛出 501，
// 由插件端回退到本地启发式引擎。
//
// 📖 [AI] 修改前必读: /.ai-instructions.md #修改API必备步骤
// 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md

const { hasAiKey, aiComplete } = require("./aiClient");

/** 发言风格目录：styleKey -> 中文标签。插件端与之保持一致。 */
const STYLE_CATALOG = {
  rational: "理性反驳",
  troll: "胡搅蛮缠",
  deflect: "转移话题",
  mock: "阴阳怪气",
  deescalate: "以和为贵",
  support: "附和声援",
};

const DEFAULT_STYLES = ["rational", "troll", "deflect"];

function styleLabel(key) {
  return STYLE_CATALOG[key] || String(key || "").trim() || "自定义";
}

/**
 * 生成三条发言方案。
 * @param {object} p
 * @param {string} p.draft          用户输入框里已有的草稿（可空）
 * @param {string} [p.platform]     当前平台标识（bilibili / weibo / tieba ...）
 * @param {string} [p.context]      页面上下文（对方发言、楼主观点等），已截断
 * @param {string} [p.persona]      加装的人格 / 个人风格描述
 * @param {string[]} [p.styleHints] 期望的风格 styleKey 列表（用于把常用风格排前）
 * @returns {Promise<{schemes: Array, model: string}>}
 */
async function generateReplySchemes({ draft, platform, context, persona, styleHints } = {}) {
  if (!hasAiKey()) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const wantedStyles = Array.isArray(styleHints) && styleHints.length
    ? styleHints.filter((s) => STYLE_CATALOG[s]).slice(0, 3)
    : [];
  const styleOrder = Array.from(new Set([...wantedStyles, ...DEFAULT_STYLES])).slice(0, 3);

  const catalogText = Object.entries(STYLE_CATALOG)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const prompt = `
你是「卢本伟广场」的对线军师，帮助中文用户在评论区/私信里组织三条不同风格的回复方案。
根据用户草稿、当前平台与上下文，输出恰好 3 条方案，风格互不相同。
可选风格（styleKey: 含义）：
${catalogText}

优先采用这三个风格（按顺序，若上下文明显不合适可替换为目录中更贴切的风格）：${styleOrder.join(", ")}

严格返回 JSON（不要 markdown、不要多余文字），结构：
{
  "schemes": [
    { "styleKey": "rational", "text": "……回复正文……", "note": "一句话点评/风险提示" }
  ]
}

要求：
- text 使用与草稿相同的语言（默认简体中文），口语、可直接发送，长度 <= 200 字，不带引号包裹。
- 结合草稿与上下文，不要空泛套话；草稿为空时按上下文/平台给出开场发言。
- 三条 styleKey 必须互不相同。
- 只输出 JSON。

平台：${platform || "unknown"}
${persona ? `用户人格/个人风格：${String(persona).slice(0, 400)}` : ""}
页面上下文：${String(context || "").slice(0, 1200)}
用户草稿：${String(draft || "").slice(0, 600)}
`;

  const { text, model } = await aiComplete(prompt, { fallbackModel: "gpt-5.2" });
  const jsonTextMatch = text.match(/\{[\s\S]*\}/);
  const jsonText = jsonTextMatch ? jsonTextMatch[0] : "";

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    data = { schemes: [] };
  }

  const rawSchemes = Array.isArray(data.schemes) ? data.schemes : [];
  const schemes = rawSchemes
    .slice(0, 3)
    .map((s, i) => {
      const styleKey = STYLE_CATALOG[s?.styleKey] ? s.styleKey : styleOrder[i] || DEFAULT_STYLES[i] || "rational";
      return {
        id: `srv-${i}`,
        styleKey,
        styleLabel: styleLabel(styleKey),
        text: String(s?.text || "").trim().slice(0, 400),
        note: String(s?.note || "").trim().slice(0, 200),
      };
    })
    .filter((s) => s.text);

  return { schemes, model };
}

module.exports = { generateReplySchemes, STYLE_CATALOG, DEFAULT_STYLES };
