const OpenAI = require("openai");

function getClient() {
  // SDK 会默认读 OPENAI_API_KEY；这里显式写更清晰
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function generateIdeaReview({ title, summary, content, tags }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  const prompt = `
You are an evaluator for startup/product ideas.
Return STRICT JSON with keys:
- feasibilityScore (0-100)
- profitPotentialScore (0-100)
- analysisText (string, concise but useful, bullet points OK)

Idea:
Title: ${title}
Summary: ${summary || ""}
Tags: ${(tags || []).join(", ")}
Content: ${content || ""}
`;

  // 使用官方 SDK 的 Responses API（文档示例）
  const resp = await client.responses.create({
    model,
    input: prompt,
  });

  const text = resp.output_text || "";

  // 尝试从模型输出中解析 JSON（允许模型输出含多余文字时兜底）
  const jsonTextMatch = text.match(/\{[\s\S]*\}/);
  const jsonText = jsonTextMatch ? jsonTextMatch[0] : "";

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    // 解析失败：做一个保底结构
    data = {
      feasibilityScore: 50,
      profitPotentialScore: 50,
      analysisText: text.trim() || "AI returned empty response.",
    };
  }

  // 规范化（防止越界/类型错）
  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

  return {
    feasibilityScore: clamp(data.feasibilityScore),
    profitPotentialScore: clamp(data.profitPotentialScore),
    analysisText: String(data.analysisText || "").slice(0, 8000),
    model,
    createdAt: new Date(),
  };
}

module.exports = { generateIdeaReview };
