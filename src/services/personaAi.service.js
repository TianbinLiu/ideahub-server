// src/services/personaAi.service.js
// 人格 AI 服务：素材分析（analyzeMaterials）+ 人格卡草稿生成（generatePersonaDraft）。
// 只产【草稿】不落库 —— 创建仍走 POST /api/personas 的既有链路（校验/归属/shared 由它管），
// 用户取消时不会留下孤儿人格，AI 输出也天然过一遍 createPersona 的归一。
//
// 为什么拆成两步：向导里"整体再来一版 / 只换开场白"要能重跑第二步而不重读素材；素材最多 60k 字，
// 抽样 + 分析一次就够，分析结果（analysis）由客户端原样带回第二步，服务器不存会话。
// ★ 所有进出模型的文本都过 scrubPii：手机号 / 身份证 / 邮箱 / IP 一律 ***，素材里的隐私不进任何字段。
const { hasAiKey, aiComplete } = require("./aiClient");

/** 进提示词的素材上限（字）；超出按段均匀抽样 */
const MAX_PROMPT_CHARS = 12000;
/** 与 persona.schemas.js styleBody / createBody 的上限逐项对齐：zod 是【拒绝】不是截断，草稿混进一条超长就会让「创建」400 */
const LIMITS = {
  name: 120, description: 1000, coverEmoji: 8, tag: 30, tags: 12,
  summary: 2000, catchphrase: 120, catchphrases: 12, stanceHint: 500,
  tone: 300, addressUser: 60, greeting: 300, example: 300, examples: 8, boundary: 120, boundaries: 12,
};
/** 问卷键 → 中文标签（客户端也用这套键；未知键原样渲染） */
const QUESTIONNAIRE_LABELS = {
  extroversion: "外向 ↔ 内向（0 外向 100 内向）",
  rationality: "理性 ↔ 感性（0 理性 100 感性）",
  formality: "正式 ↔ 随意（0 正式 100 随意）",
  humor: "幽默感（0～100）",
  talkative: "话多 ↔ 话少（0 话多 100 话少）",
  politeness: "敬语程度（0～100）",
  emotional: "情绪外露度（0～100）",
  catchphrase: "口头禅",
  addressUser: "怎么称呼用户",
  language: "语言（zh / en / mixed）",
  emoji: "emoji 用量（none / light / heavy）",
  taboos: "禁忌话题",
};

const PII_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/g, // 手机号
  /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, // 身份证
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // 邮箱
  /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, // IP
];

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

function scrubPii(text) {
  let s = String(text || "");
  for (const re of PII_PATTERNS) s = s.replace(re, "***");
  return s;
}

function str(v, max) {
  return scrubPii(String(v == null ? "" : v)).trim().slice(0, max);
}
function strList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

/**
 * 素材按段落切开、总量超过 MAX_PROMPT_CHARS 时均匀抽样（保留顺序、每段最多 1500 字）。
 * @param {{kind?: string, text: string}[]} materials
 * @returns {{kind: string, text: string}[]}
 */
function sampleMaterials(materials) {
  const blocks = [];
  for (const m of Array.isArray(materials) ? materials : []) {
    const kind = String((m && m.kind) || "notes");
    const paras = String((m && m.text) || "")
      .split(/\r?\n\s*\r?\n|\r?\n(?=\S)/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of paras) blocks.push({ kind, text: p.slice(0, 1500) });
  }
  const total = blocks.reduce((n, b) => n + b.text.length, 0);
  if (total <= MAX_PROMPT_CHARS) return blocks;
  const ratio = MAX_PROMPT_CHARS / total;
  const out = [];
  let acc = 0;
  let budget = MAX_PROMPT_CHARS;
  for (const b of blocks) {
    acc += ratio;
    if (acc < 1) continue;
    acc -= 1;
    if (budget <= 0) break;
    const text = b.text.slice(0, budget);
    out.push({ kind: b.kind, text });
    budget -= text.length;
  }
  return out;
}

function normalizeAnalysis(data) {
  const d = data && typeof data === "object" ? data : {};
  const habits = d.habits && typeof d.habits === "object" ? d.habits : {};
  const out = {};
  for (const [k, v] of Object.entries(habits).slice(0, 12)) {
    const key = String(k).trim().slice(0, 40);
    if (key) out[key] = str(v, 200);
  }
  return {
    catchphrases: strList(d.catchphrases, 20, LIMITS.catchphrase),
    habits: out,
    stances: strList(d.stances, 12, 200),
    topics: strList(d.topics, 20, 60),
    avoids: strList(d.avoids, 20, 60),
    samples: strList(d.samples, 10, 300),
  };
}

/**
 * 第一步：从素材提炼"这个人怎么说话"。
 * @param {object} opts
 * @param {{kind?: "chat"|"posts"|"notes", text: string}[]} opts.materials
 * @param {string} [opts.speaker] 聊天记录里哪个昵称是"TA"（空 = 让模型挑最鲜明的一位）
 * @returns {Promise<{analysis: object, model: string, sampledChars: number}>}
 */
async function analyzeMaterials({ materials, speaker }) {
  requireKey();
  const blocks = sampleMaterials(materials);
  const body = blocks.map((b) => `[${b.kind}] ${scrubPii(b.text)}`).join("\n");
  const who = String(speaker || "").trim();
  const prompt = [
    "你是一个「说话风格分析师」。下面是某个人的发言素材（聊天记录 / 帖子 / 笔记，已抽样），请分析 TA 怎么说话。",
    who ? `聊天记录里昵称为「${who}」的人是分析对象，其他人的话只当上下文。` : "若素材里有多个说话人，选风格最鲜明的那一位。",
    "",
    "只返回 JSON（不要 markdown、不要解释），字段：",
    "{",
    '  "catchphrases": ["原文里真的出现过的口头禅 / 高频短语，3~10 条，保留原话"],',
    '  "habits": { "sentenceLength": "短/中/长 + 一句说明", "punctuation": "标点习惯", "emoji": "表情/颜文字习惯", "particles": "常用语气词", "tone": "整体语气一句话" },',
    '  "stances": ["立场 / 价值观 / 待人方式，1~6 条"],',
    '  "topics": ["常聊的话题，3~10 个"],',
    '  "avoids": ["明显回避或反感的话题，0~6 个"],',
    '  "samples": ["最能代表 TA 风格的原话 3~6 段，每段 ≤ 80 字，删掉人名与隐私"]',
    "}",
    "",
    "要求：一切以原文证据为准，不编造；人名、手机号、地址等隐私不得进入任何字段。",
    "",
    "素材：",
    "-----",
    body,
    "-----",
  ].join("\n");
  const { text, model } = await aiComplete(prompt);
  const data = parseJsonObject(text);
  if (!data) {
    const err = new Error("AI 返回的分析无法解析，请重试");
    err.status = 502;
    throw err;
  }
  return { analysis: normalizeAnalysis(data), model, sampledChars: body.length };
}

function renderQuestionnaire(q) {
  if (!q || typeof q !== "object") return [];
  const lines = [];
  for (const [k, v] of Object.entries(q).slice(0, 30)) {
    const label = QUESTIONNAIRE_LABELS[k] || String(k).slice(0, 40);
    const value = Array.isArray(v) ? v.map((x) => str(x, 60)).filter(Boolean).join("、") : str(v, 200);
    if (value !== "") lines.push(`- ${label}：${value}`);
  }
  return lines;
}

function normalizeDraft(data) {
  const d = data && typeof data === "object" ? data : {};
  const examples = Array.isArray(d.examples)
    ? d.examples
        .map((e) => ({ user: str(e && e.user, LIMITS.example), reply: str(e && e.reply, LIMITS.example) }))
        .filter((e) => e.user && e.reply)
        .slice(0, LIMITS.examples)
    : [];
  return {
    name: str(d.name, LIMITS.name),
    description: str(d.description, LIMITS.description),
    coverEmoji: String(d.coverEmoji || "🎭").trim().slice(0, LIMITS.coverEmoji),
    tags: strList(d.tags, LIMITS.tags, LIMITS.tag),
    style: {
      summary: str(d.summary, LIMITS.summary),
      catchphrases: strList(d.catchphrases, LIMITS.catchphrases, LIMITS.catchphrase),
      stats: [],
      stanceHint: str(d.stanceHint, LIMITS.stanceHint),
      tone: str(d.tone, LIMITS.tone),
      addressUser: str(d.addressUser, LIMITS.addressUser),
      greeting: str(d.greeting, LIMITS.greeting),
      examples,
      boundaries: strList(d.boundaries, LIMITS.boundaries, LIMITS.boundary),
    },
  };
}

/** 把客户端带回来的草稿（{name, description, coverEmoji, tags, style}）摊平成与模型输出同形，供 only 合并 */
function flattenDraft(draft) {
  const d = draft && typeof draft === "object" ? draft : {};
  const s = d.style && typeof d.style === "object" ? d.style : {};
  return { name: d.name, description: d.description, coverEmoji: d.coverEmoji, tags: d.tags, ...s };
}

const ONLY_FIELDS = ["name", "description", "tags", "summary", "catchphrases", "stanceHint", "tone", "addressUser", "greeting", "examples", "boundaries"];

/**
 * 第二步：合成人格卡草稿。
 * @param {object} opts
 * @param {string} [opts.chatText]  老入口：直接贴一段聊天记录（没有 analysis 时当素材用）
 * @param {string} [opts.hint]      老入口：提炼要求
 * @param {object} [opts.basics]    向导第 1 步：{ name, role, relation, intro, addressUser }
 * @param {object} [opts.questionnaire] 向导第 3 步：键见 QUESTIONNAIRE_LABELS
 * @param {object} [opts.analysis]  analyzeMaterials 的结果
 * @param {string[]} [opts.only]    只重生成这些字段（需同时给 draft）
 * @param {object} [opts.draft]     当前草稿（only 模式下其余字段照抄它）
 */
async function generatePersonaDraft({ chatText, hint, basics, questionnaire, analysis, only, draft } = {}) {
  requireKey();
  const b = basics && typeof basics === "object" ? basics : {};
  const onlyList = Array.isArray(only) ? only.filter((f) => ONLY_FIELDS.includes(f)) : [];
  const partial = onlyList.length > 0 && draft && typeof draft === "object";
  const hintLine = str(hint, 200);
  const basicsLines = [
    b.name ? `- 名字：${str(b.name, LIMITS.name)}` : "",
    b.role ? `- 定位：${str(b.role, 60)}` : "",
    b.relation ? `- 与用户的关系：${str(b.relation, 120)}` : "",
    b.intro ? `- 一句话简介：${str(b.intro, 300)}` : "",
    b.addressUser ? `- 称呼用户：${str(b.addressUser, LIMITS.addressUser)}` : "",
  ].filter(Boolean);
  const qLines = renderQuestionnaire(questionnaire);
  const a = analysis && typeof analysis === "object" ? normalizeAnalysis(analysis) : null;
  const rawChat = str(chatText, MAX_PROMPT_CHARS);

  const prompt = [
    "你是一个「角色设定师」。请根据下面的信息，合成一个可以直接让 AI 扮演的「人格卡」，用于陪聊 / 客服数字人。",
    hintLine ? `额外要求：${hintLine}` : "",
    basicsLines.length ? "\n【基本设定（用户填的，优先级最高）】\n" + basicsLines.join("\n") : "",
    qLines.length ? "\n【性格问卷】\n" + qLines.join("\n") : "",
    a ? "\n【素材分析（来自 TA 的真实发言）】\n" + JSON.stringify(a, null, 0) : "",
    rawChat && !a ? "\n【原始发言素材】\n-----\n" + rawChat + "\n-----" : "",
    partial
      ? `\n【当前草稿】\n${JSON.stringify(flattenDraft(draft), null, 0)}\n只重新生成这些字段：${onlyList.join("、")}；其余字段照抄当前草稿。`
      : "",
    "",
    "只返回 JSON（不要 markdown、不要解释），字段：",
    "{",
    '  "name": "人格名（2~12 字；用户给了名字就用用户的；不得是真实存在的公众人物）",',
    '  "description": "一句话简介：什么身份、什么风格、适合什么场合（≤ 60 字）",',
    '  "coverEmoji": "一个最贴合的 emoji",',
    '  "tags": ["3~6 个标签：身份类 + 风格类"],',
    '  "summary": "怎么说话（80~200 字）：句长、语气词、标点、怼人还是打圆场、情绪怎么表达——要能指导 AI 模仿，不写内容摘要",',
    '  "catchphrases": ["口头禅 3~8 条；有素材就用素材里的原话"],',
    '  "stanceHint": "立场 / 倾向 / 待人方式（≤ 60 字）",',
    '  "tone": "语气一句话（≤ 40 字）",',
    '  "addressUser": "怎么称呼用户（≤ 10 字）",',
    '  "greeting": "第一次见面的开场白，1~2 句，用 TA 的口吻",',
    '  "examples": [{ "user": "用户说的话", "reply": "TA 会怎么回（1~3 句，体现口癖与语气）" }],  // 4~8 组，覆盖 打招呼 / 被夸 / 被问不会的事 / 用户难过 / 闲聊',
    '  "boundaries": ["TA 自己的边界，0~6 条，如「不聊前任」「不评价别家产品」"]',
    "}",
    "",
    "硬性要求：",
    "- 素材里的口头禅、句式必须真的出现过或高度贴近，不编造；素材与问卷冲突时以用户填的基本设定和问卷为准。",
    "- 不得冒充真实存在的人；不得声称自己是人类；人格不得鼓励违法、自残、伤害他人，不得性化未成年人。",
    "- 素材中的人名、手机号、地址等隐私不得进入任何字段。",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const { text, model } = await aiComplete(prompt);
  const data = parseJsonObject(text);
  if (!data || (!partial && !String(data.name || "").trim())) {
    const err = new Error("AI 返回的人格无法解析，请重试");
    err.status = 502;
    throw err;
  }
  let merged = data;
  if (partial) {
    const base = flattenDraft(draft);
    merged = { ...base };
    for (const f of onlyList) if (data[f] !== undefined) merged[f] = data[f];
    merged.coverEmoji = base.coverEmoji || data.coverEmoji;
  }
  // 用户填了名字就以用户为准（模型偶尔会"润色"名字）
  if (b.name && !onlyList.includes("name")) merged.name = b.name;
  if (b.addressUser && !merged.addressUser) merged.addressUser = b.addressUser;
  return { ...normalizeDraft(merged), model };
}

/** 老入口（情景编辑器「✨从聊天记录生成」）：一段聊天文本 → 草稿 */
async function generatePersonaFromChat({ chatText, hint }) {
  return generatePersonaDraft({ chatText, hint });
}

module.exports = {
  MAX_PROMPT_CHARS,
  QUESTIONNAIRE_LABELS,
  ONLY_FIELDS,
  scrubPii,
  sampleMaterials,
  analyzeMaterials,
  generatePersonaDraft,
  generatePersonaFromChat,
};
