const OpenAI = require("openai");

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

async function generateWorkshopEditPlan({ instruction, history = [], draft }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.4";
  const conversation = history
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-6)
    .map((item) => `${item.role.toUpperCase()}: ${String(item.content || "").slice(0, 300)}`)
    .join("\n");

  const layoutItems = Array.isArray(draft?.layout?.pages?.home?.items)
    ? draft.layout.pages.home.items.map((item) => ({
        id: item.id,
        label: item.label,
        kind: item.kind,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        visible: item.visible,
      }))
    : [];

  const prompt = `
You are a safe UI workshop editor for IdeaHub.
Return STRICT JSON only with this shape:
{
  "assistantMessage": string,
  "changes": {
    "title"?: string,
    "summary"?: string,
    "tags"?: string[],
    "theme"?: {
      "backgroundType"?: "none" | "image" | "video" | "gradient",
      "backgroundUrl"?: string,
      "accentColor"?: string,
      "textColor"?: string,
      "cardRadius"?: number,
      "cardOpacity"?: number,
      "customCss"?: string,
      "componentCss"?: {
        "card"?: string,
        "button"?: string,
        "title"?: string
      }
    },
    "layout"?: {
      "items"?: [
        {
          "id": string,
          "x"?: number,
          "y"?: number,
          "w"?: number,
          "h"?: number,
          "visible"?: boolean,
          "z"?: number
        }
      ]
    }
  }
}

Safety rules:
- Never invent unknown layout ids.
- Only modify fields requested by the user.
- Keep layout numbers in percentages for a 0-100 canvas.
- Keep title concise.
- Only use safe CSS declarations if CSS is required.
- If the request is unclear or unsafe, explain the limitation in assistantMessage and leave changes empty.

Conversation history:
${conversation || "(none)"}

Current draft:
${JSON.stringify({
    title: draft?.title || "",
    summary: draft?.summary || "",
    tags: draft?.tags || [],
    theme: draft?.theme || {},
    layoutItems,
  })}

User instruction:
${String(instruction || "").slice(0, 600)}
`;

  const resp = await client.responses.create({
    model,
    input: prompt,
  });

  const payload = parseJsonObject(resp.output_text || "") || {};
  return {
    assistantMessage: String(payload.assistantMessage || "已根据安全规则生成一版草案。"),
    changes: payload.changes && typeof payload.changes === "object" ? payload.changes : {},
    model,
  };
}

async function generateSiteDraftEditPlan({ instruction, history = [], pageKey, siteDraft, nodeCatalog = [] }) {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY is not set on server");
    err.status = 501;
    throw err;
  }

  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.4";
  const conversation = history
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-8)
    .map((item) => `${item.role.toUpperCase()}: ${String(item.content || "").slice(0, 360)}`)
    .join("\n");

  const prompt = `
You are a safe global site editor for IdeaHub full-site edit mode.
Return STRICT JSON only with this shape:
{
  "assistantMessage": string,
  "operations": {
    "updateNodes"?: [
      {
        "nodeId": string,
        "x"?: number,
        "y"?: number,
        "width"?: number,
        "height"?: number,
        "css"?: string
      }
    ],
    "createWidgets"?: [
      {
        "id"?: string,
        "type"?: "text" | "button" | "badge" | "image" | "card" | "link-list" | "form",
        "text": string,
        "href"?: string,
        "imageUrl"?: string,
        "items"?: string[],
        "fields"?: string[],
        "x": number,
        "y": number,
        "width"?: number,
        "height"?: number,
        "css"?: string
      }
    ],
    "removeWidgetIds"?: string[],
    "pageBackground"?: {
      "backgroundType"?: "none" | "image" | "video" | "gradient",
      "backgroundUrl"?: string
    }
  }
}

Safety rules:
- Only reference nodeId values that exist in nodeCatalog.
- CSS must contain only safe declarations; avoid url(), @import, script-like content.
- createWidgets is the only way to add new components.
- Keep numbers in reasonable viewport px ranges.
- If instruction is unclear, keep operations minimal and explain in assistantMessage.

Current pageKey: ${String(pageKey || "/")}
Current page draft snapshot:
${JSON.stringify(siteDraft?.pages?.[pageKey] || {}, null, 2).slice(0, 5000)}

Selectable node catalog (id + hint):
${JSON.stringify(nodeCatalog || [], null, 2).slice(0, 4000)}

Conversation history:
${conversation || "(none)"}

User instruction:
${String(instruction || "").slice(0, 800)}
`;

  const resp = await client.responses.create({ model, input: prompt });
  const payload = parseJsonObject(resp.output_text || "") || {};
  return {
    assistantMessage: String(payload.assistantMessage || "已生成全站改版操作草案。"),
    operations: payload.operations && typeof payload.operations === "object" ? payload.operations : {},
    model,
  };
}

module.exports = { generateWorkshopEditPlan, generateSiteDraftEditPlan };