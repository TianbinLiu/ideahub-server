// src/services/scenarioAi.service.js
// 情景模拟 AI 服务：生成种子评论区 + AI 扮演页面账号与用户对线
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

function clampInt(value, fallback, min, max) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

const PLATFORM_LABEL = {
  bilibili: "哔哩哔哩（B站）视频评论区",
  weibo: "微博评论区",
  tieba: "百度贴吧",
  zhihu: "知乎回答/评论区",
  instagram: "Instagram 评论区",
  generic: "通用社交平台评论区",
};

const INTENSITY_LABEL = {
  mild: "温和理性，观点有分歧但克制",
  heated: "情绪比较激烈，互相反驳，火药味明显",
  flame: "非常激烈，接近对线互喷，但不出现违法或露骨人身攻击的极端脏话",
};

function roleLabel(role) {
  if (role === "user") return "用户";
  if (role === "ai") return "AI账号";
  return "种子评论";
}

function dedupeAccounts(accounts) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(accounts) ? accounts : []) {
    const name = String(a?.authorName || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      authorName: name,
      stance: String(a?.stance || ""),
      isOP: !!a?.isOP,
      authorAvatar: a?.authorAvatar || "",
      text: String(a?.text || ""),
    });
  }
  return out;
}

// ── 种子评论区生成 ───────────────────────────────────────────────

function buildFallbackSeed(topic, n) {
  const t = String(topic || "这个话题").slice(0, 40);
  const templates = [
    { text: `说实话，关于「${t}」我坚定站正方，理由很充分。`, stance: "支持正方", isOP: true, replyToIndex: null },
    { text: `楼主纯属带节奏，「${t}」明显是反方更有道理。`, stance: "支持反方", replyToIndex: 0 },
    { text: `你们吵来吵去有意思吗？「${t}」这事没那么绝对。`, stance: "中立和稀泥", replyToIndex: null },
    { text: `数据不会骗人，正方赢麻了，别嘴硬。`, stance: "用数据支持正方", replyToIndex: 0 },
    { text: `反方+1，别被表面现象骗了。`, stance: "坚定反方", replyToIndex: 1 },
    { text: `理性讨论，双方各有道理，别动不动上升。`, stance: "呼吁理性", replyToIndex: null },
    { text: `笑死，这也能吵起来，图个乐。`, stance: "看热闹不嫌事大", replyToIndex: null },
    { text: `就这？正方随便反驳一下就赢了。`, stance: "嘲讽反方", replyToIndex: 4 },
  ];
  const size = Math.max(4, Math.min(n, templates.length));
  return templates.slice(0, size).map((x) => ({
    authorName: "",
    text: x.text,
    stance: x.stance,
    isOP: !!x.isOP,
    replyToIndex: x.replyToIndex ?? null,
    likeCount: Math.floor(Math.random() * 800),
  }));
}

function mapSeedComments(rawComments) {
  const list = (Array.isArray(rawComments) ? rawComments : []).slice(0, 20);
  const ids = list.map((_, i) => `seed_${i + 1}`);
  let opAssigned = false;

  const out = list.map((c, i) => {
    const replyRaw = c && (c.replyToIndex ?? c.replyTo ?? null);
    let parentId = null;
    if (replyRaw !== null && replyRaw !== undefined && replyRaw !== "") {
      const idx = parseInt(replyRaw, 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx < list.length && idx !== i) {
        parentId = ids[idx];
      }
    }

    let isOP = Boolean(c && c.isOP);
    if (isOP && !opAssigned) {
      opAssigned = true;
    } else {
      isOP = false;
    }

    return {
      id: ids[i],
      authorName: String(c?.authorName || "").trim().slice(0, 80) || `网友${i + 1}`,
      authorAvatar: "",
      text: String(c?.text || "").trim().slice(0, 2000),
      likeCount: clampInt(c?.likeCount, Math.floor(Math.random() * 500), 0, 99999999),
      parentId,
      isOP,
      stance: String(c?.stance || "").trim().slice(0, 200),
    };
  });

  if (!opAssigned && out.length > 0) {
    const firstTop = out.find((c) => !c.parentId) || out[0];
    firstTop.isOP = true;
  }

  return out;
}

async function generateSeedComments({ topic, platform = "generic", intensity = "heated", count = 12 }) {
  requireKey();

  const n = clampInt(count, 12, 4, 20);
  const platformLabel = PLATFORM_LABEL[platform] || PLATFORM_LABEL.generic;
  const intensityLabel = INTENSITY_LABEL[intensity] || INTENSITY_LABEL.heated;

  const prompt = `
你在为一个"情景模拟"功能生成一段仿真的${platformLabel}。
争论主题：${String(topic || "").slice(0, 800)}
氛围强度：${intensityLabel}

要求：
- 生成 ${n} 条评论，围绕主题形成明显对立的多方立场（至少两派互相争论）。
- 其中包含若干"回复"（针对前面某条评论的回怼/附和），用 replyToIndex 指向被回复评论在数组中的下标（从 0 开始，且必须小于当前项下标）；顶楼评论 replyToIndex 为 null。
- 指定且仅指定一条评论 isOP 为 true（楼主/发起者），且应为顶楼评论。
- 每条评论给出 stance：用一句话概括这个账号的观点/立场，供后续 AI 扮演该账号使用。
- authorName 使用符合该平台风格的中文网名，不要重复。
- likeCount 给一个合理的随机点赞数（0~99999，热门/犀利观点更高）。
- 评论内容口语化、有网感、符合该平台风格，中文输出。

只返回 STRICT JSON，形如：
{
  "comments": [
    { "authorName": string, "text": string, "stance": string, "isOP": boolean, "replyToIndex": number|null, "likeCount": number }
  ]
}
不要输出 JSON 以外的任何内容。
`;

  const { text, model } = await aiComplete(prompt, { fallbackModel: "gpt-5.2" });
  const payload = parseJsonObject(text);
  const rawComments = payload && Array.isArray(payload.comments) && payload.comments.length
    ? payload.comments
    : buildFallbackSeed(topic, n);

  return { comments: mapSeedComments(rawComments), model };
}

// ── AI 扮演账号与用户对线 ─────────────────────────────────────────

function buildFallbackReplies(accountList, userMessage) {
  const withStance = accountList.filter((a) => a.stance);
  const chosen = (withStance.length ? withStance : accountList).slice(0, 2);
  const base = chosen.length ? chosen : [{ authorName: "路人网友", stance: "", authorAvatar: "" }];
  const snippet = String(userMessage?.text || "").slice(0, 24);
  return base.map((a) => ({
    authorName: a.authorName || "路人网友",
    authorAvatar: a.authorAvatar || "",
    text: `就你这观点也好意思发？关于「${snippet}」，我是完全不认同的。`,
  }));
}

async function generateRolePlayReplies({ scenario, history = [], userMessage }) {
  requireKey();

  const accountList = dedupeAccounts(scenario?.comments).slice(0, 20);
  const roster = accountList
    .map((a, i) => `${i + 1}. ${a.authorName}${a.isOP ? "（楼主）" : ""} — 立场：${a.stance || "（未标注，请根据其历史发言推断）"}`)
    .join("\n");

  const seedComments = (Array.isArray(scenario?.comments) ? scenario.comments : [])
    .slice(0, 30)
    .map((c) => `${c.authorName}: ${String(c.text || "").slice(0, 200)}`)
    .join("\n");

  const convo = (Array.isArray(history) ? history : [])
    .slice(-12)
    .map((h) => `${roleLabel(h?.role)}｜${String(h?.authorName || "").slice(0, 40)}: ${String(h?.text || "").slice(0, 300)}`)
    .join("\n");

  const platformLabel = PLATFORM_LABEL[scenario?.platform] || PLATFORM_LABEL.generic;

  const prompt = `
你在一个"情景模拟"里扮演${platformLabel}中的若干个账号，与真实用户"对线"。
争论主题：${String(scenario?.topic || scenario?.title || "").slice(0, 800)}

可扮演的账号及其立场：
${roster || "（无固定账号，请即兴扮演 1~3 个符合该平台风格的网友）"}

评论区已有的种子发言：
${seedComments || "（无）"}

最近的对话记录：
${convo || "（无）"}

真实用户刚刚发表的新发言：
${String(userMessage?.text || "").slice(0, 600)}

要求：
- 从上面的账号里挑选 1~3 个（尽量选立场与用户对立、最有戏剧性的），以他们的身份分别回复用户这条发言。
- 每条回复必须符合该账号的既有立场与说话风格，观点鲜明、有火药味，但不使用违法或露骨的人身攻击。
- authorName 必须是上面列出的账号名之一（若上面没有账号，则自拟一个符合该平台风格的中文网名）。
- 中文输出，口语化、有网感、简短有力。

只返回 STRICT JSON，形如：
{ "replies": [ { "authorName": string, "text": string } ] }
不要输出 JSON 以外的任何内容。
`;

  const { text, model } = await aiComplete(prompt, { fallbackModel: "gpt-5.2" });
  const payload = parseJsonObject(text);
  const rawReplies = payload && Array.isArray(payload.replies) && payload.replies.length
    ? payload.replies
    : buildFallbackReplies(accountList, userMessage);

  const avatarByName = new Map(accountList.map((a) => [a.authorName, a.authorAvatar || ""]));

  const replies = rawReplies
    .slice(0, 3)
    .map((r) => {
      const name = String(r?.authorName || "").trim().slice(0, 80) || accountList[0]?.authorName || "路人网友";
      return {
        authorName: name,
        authorAvatar: avatarByName.get(name) || "",
        text: String(r?.text || "").trim().slice(0, 2000),
      };
    })
    .filter((r) => r.text);

  const finalReplies = replies.length ? replies : buildFallbackReplies(accountList, userMessage);
  return { replies: finalReplies, model };
}

module.exports = { generateRolePlayReplies, generateSeedComments };
