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

// ★ 风格【不再写死】。标签由 AI 按每条方案的【实际风格】实时生成（含正式/工作场合），
//   下面这份仅作 prompt 里给 AI 看的【示例范围】，不是可选清单、不做输出校验。
//   （历史遗留的固定 styleKey 目录已退役；插件端不再按固定键计数/重排。）
const STYLE_EXAMPLES = [
  "理性反驳",
  "专业澄清",
  "委婉拒绝",
  "附和补充",
  "幽默化解",
  "直接了当",
  "以和为贵",
  "正式回应",
];

/**
 * 生成【可变条数】的发言方案，每条带 AI 实时生成的风格标签与推荐理由。
 * @param {object} p
 * @param {string} p.draft        用户输入框里已有的草稿（可空）
 * @param {string} [p.platform]   当前平台标识（bilibili / weibo / gmail ...）
 * @param {string} [p.context]    页面上下文（对方发言、楼主观点等），已截断
 * @param {string} [p.persona]    加装的人格 / 个人风格描述——定基调
 * @param {number} [p.count]      本轮生成几条（默认 3；用户点「更多」时递增）
 * @param {string[]} [p.avoid]    已给过的方案正文——本轮要与之明显不同
 * @returns {Promise<{schemes: Array, model: string}>}
 *   每条 scheme: { id, label, rationale, text, styleLabel, styleKey, note }
 *   （label/rationale 为新字段；styleLabel/styleKey/note 为旧字段别名，兼容旧版插件）
 */
async function generateReplySchemes({ draft, platform, context, persona, count, avoid } = {}) {
  if (!hasAiKey()) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const n = Math.min(6, Math.max(1, Number(count) || 3));
  const avoidList = (Array.isArray(avoid) ? avoid : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 12);

  const avoidBlock = avoidList.length
    ? `\n【不要重复以下已经给过的方案】——风格和内容都要有明显区别：\n${avoidList
        .map((t, i) => `${i + 1}. ${t.slice(0, 160)}`)
        .join("\n")}\n`
    : "";

  const prompt = `
你是「卢本伟广场」的发言军师，帮中文用户在【任意场合】（评论区、私信、也包括工作邮件、正式沟通）组织 ${n} 条【风格各不相同】的回复方案。

关键：方案要【适配当前场合】。若上下文是正式/工作/客服等场景，就给专业、得体、有分寸的风格，【不要】默认抬杠或阴阳怪气；若是网络对线场景，才可以给更有攻击性的风格。风格由你判断，不要套固定模板。

每条方案包含三个字段：
- label：2~6 个字，概括这条方案的【实际风格】，由你按内容【实时生成】（示例风格，仅供参考、不是限定清单：${STYLE_EXAMPLES.join(" / ")}）。
- rationale：一句话说明这条【适合什么情况、为什么这样写】，帮用户判断该不该用。
- text：可直接发送的正文，与草稿同语言（默认简体中文），长度 <= 200 字，口语自然，不要用引号包裹整段。
${avoidBlock}
严格返回 JSON（不要 markdown、不要多余文字）：
{"schemes":[{"label":"专业澄清","rationale":"对方可能误解了你的意思，用事实平静澄清、不升级冲突","text":"……"}]}

要求：
- 恰好 ${n} 条；每条 label 互不相同、text 互不相同。
- 结合草稿与上下文，不要空泛套话；草稿为空时按上下文/平台给出开场发言。
- 只输出 JSON。

平台：${platform || "unknown"}
${persona ? `用户人格/个人风格（作为基调贯穿所有方案）：${String(persona).slice(0, 400)}` : ""}
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
    .slice(0, n)
    .map((s, i) => {
      const label = String(s?.label || s?.styleLabel || "").trim().slice(0, 12) || "方案";
      const rationale = String(s?.rationale || s?.note || "").trim().slice(0, 200);
      const body = String(s?.text || "").trim().slice(0, 400);
      return {
        id: `srv-${i}`,
        label, // 新：AI 实时生成的风格标签
        rationale, // 新：推荐理由/原因
        text: body,
        // 旧字段别名，兼容线上旧版插件（renderSchemes 读 styleLabel/note；styleKey 不再有语义）
        styleLabel: label,
        styleKey: "custom",
        note: rationale,
      };
    })
    .filter((s) => s.text);

  return { schemes, model };
}

module.exports = { generateReplySchemes, STYLE_EXAMPLES };
