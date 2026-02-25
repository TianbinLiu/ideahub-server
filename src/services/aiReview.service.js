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

/**
 * Validate and categorize feedback submission
 * @returns {Promise<{isValid: boolean, feedbackType: string, summary: string, reason?: string}>}
 */
async function validateFeedback({ title, summary, content }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.2";

  const prompt = `
You are validating user feedback for a website called IdeaHub (an idea sharing platform).
The user has submitted feedback by checking a "Bug or Feature Suggestion" checkbox.

Evaluate this submission and return STRICT JSON with keys:
- isValid (boolean): true if this is legitimate feedback (bug report or feature suggestion), false if it's gibberish, spam, off-topic, or not actual feedback
- feedbackType (string): "bug" if reporting a problem/error, "suggestion" if requesting a feature/improvement. Only set if isValid is true.
- summary (string): A concise 1-2 sentence summary of the feedback in Chinese. Only set if isValid is true.
- reason (string): If isValid is false, explain why in Chinese (e.g., "内容无意义" or "与网站反馈无关").

Submission:
Title: ${title}
Summary: ${summary || ""}
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
    // If AI fails to parse, assume valid and categorize based on keywords
    const lowerText = (title + " " + summary + " " + content).toLowerCase();
    const isBug = lowerText.includes("bug") || lowerText.includes("错误") || lowerText.includes("问题") || lowerText.includes("error");
    data = {
      isValid: true,
      feedbackType: isBug ? "bug" : "suggestion",
      summary: `${title}${summary ? ': ' + summary : ''}`.slice(0, 200),
    };
  }

  return {
    isValid: Boolean(data.isValid),
    feedbackType: data.isValid ? (data.feedbackType === "bug" ? "bug" : "suggestion") : null,
    summary: data.isValid ? String(data.summary || "").slice(0, 500) : "",
    reason: data.isValid ? null : String(data.reason || "内容无效"),
  };
}

module.exports = { generateIdeaReview, runAiReview, validateFeedback };
