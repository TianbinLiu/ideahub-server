// src/services/aiReview.service.js
const OpenAI = require("openai");

function getClient() {
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

  const resp = await client.responses.create({
    model,
    input: prompt,
  });

  const text = resp.output_text || "";
  const jsonTextMatch = text.match(/\{[\s\S]*\}/);
  const jsonText = jsonTextMatch ? jsonTextMatch[0] : "";

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    data = {
      feasibilityScore: 50,
      profitPotentialScore: 50,
      analysisText: text.trim() || "AI returned empty response.",
    };
  }

  const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

  return {
    feasibilityScore: clamp(data.feasibilityScore),
    profitPotentialScore: clamp(data.profitPotentialScore),
    analysisText: String(data.analysisText || "").slice(0, 8000),
    model,
    createdAt: new Date(),
  };
}

// ✅ Worker 入口：接收 Idea 文档
async function runAiReview(ideaDoc) {
  return generateIdeaReview({
    title: ideaDoc.title,
    summary: ideaDoc.summary,
    content: ideaDoc.content,
    tags: ideaDoc.tags || [],
  });
}

module.exports = { generateIdeaReview, runAiReview };
