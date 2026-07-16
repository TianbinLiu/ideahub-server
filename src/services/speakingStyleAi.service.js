// src/services/speakingStyleAi.service.js
// 发言风格面板 AI 服务：把用户最近的发言文本汇总成一张“JOJO 替身”能力面板。
// 有 OPENAI_API_KEY → 用 OpenAI 分析；无 key（或异常）→ 本地启发式（heuristic=true），绝不抛 501。
const OpenAI = require("openai");

function hasKey() {
  return !!process.env.OPENAI_API_KEY;
}

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

// ── 6 项固定能力（key 顺序固定 + 中文标签）─────────────────────────
const STAT_KEYS = ["attack", "venom", "logic", "armor", "resilience", "humor"];
const STAT_LABEL = {
  attack: "攻击力",
  venom: "嘴臭指数",
  logic: "逻辑性",
  armor: "叠甲熟练度",
  resilience: "抗压能力",
  humor: "幽默感",
};

// value → 字母评级
function gradeOf(value) {
  const v = Number(value) || 0;
  if (v >= 90) return "S";
  if (v >= 75) return "A";
  if (v >= 60) return "B";
  if (v >= 45) return "C";
  if (v >= 30) return "D";
  return "E";
}

function clamp100(n) {
  const v = Math.round(Number(n) || 0);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// 把 { attack, venom, ... } 数值表组装成 stats:[{key,label,value,grade}]（顺序固定，grade 派生）
function buildStats(valueMap = {}) {
  return STAT_KEYS.map((key) => {
    const value = clamp100(valueMap[key]);
    return { key, label: STAT_LABEL[key], value, grade: gradeOf(value) };
  });
}

// ── 内置替身名/模板（无 key 或兜底用）────────────────────────────
const STAND_NAMES = [
  "《白金之嘴》",
  "《黄金体验·杠精》",
  "《绯红之辩》",
  "《疯狂钻石·嘴替》",
  "《败者食尘·阴阳》",
  "《石之自由·嘴强王者》",
  "《紫烟叠甲》",
  "《狂热钢铁·键政》",
  "《世界·终结讨论》",
  "《隐者之紫·引经据典》",
];

const NEWCOMER_PHRASES = ["刚来，随便看看", "让我想想", "有道理", "先记一下"];

// 从文本挑一个 standName（无 key 时按攻击力高低粗略映射，保持稳定又不呆板）
function pickStandName(valueMap) {
  const attack = Number(valueMap.attack) || 0;
  const venom = Number(valueMap.venom) || 0;
  const logic = Number(valueMap.logic) || 0;
  const humor = Number(valueMap.humor) || 0;
  let idx;
  if (attack >= 70 && venom >= 60) idx = 0;
  else if (logic >= 70) idx = 9;
  else if (humor >= 65) idx = 5;
  else if (venom >= 60) idx = 4;
  else idx = (attack + venom + logic + humor) % STAND_NAMES.length;
  return STAND_NAMES[idx] || STAND_NAMES[0];
}

// ── 启发式特征词表 ────────────────────────────────────────────────
const ATTACK_WORDS = [
  "傻", "蠢", "脑残", "智障", "垃圾", "滚", "废物", "sb", "傻逼", "弱智", "闭嘴",
  "也配", "笑死", "不服", "怼", "杠", "反驳", "错的离谱", "你行你上", "醒醒",
];
const VENOM_WORDS = [
  "呵呵", "哈？", "就这", "拉倒", "得了吧", "省省", "阴阳", "键盘", "云玩家",
  "急了", "破防", "小丑", "typical", "绷不住", "乐", "笑不活了", "麻了",
];
const LOGIC_WORDS = [
  "依据", "来源", "数据", "首先", "其次", "因此", "所以", "逻辑", "论据",
  "事实", "证明", "前提", "结论", "反例", "定义", "严格来说", "综上",
];
const ARMOR_WORDS = [
  "客观说", "个人认为", "仅代表", "不针对", "先叠个甲", "理性讨论", "无意冒犯",
  "只是说", "一般来说", "某种程度上", "不一定", "可能", "或许", "据我所知",
];
const HUMOR_WORDS = [
  "哈哈", "233", "笑", "梗", "乐", "整活", "绷", "yyds", "狗头", "皮一下",
];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function densityScore(texts, words, perHit, base) {
  let hits = 0;
  let totalLen = 0;
  for (const t of texts) {
    const s = String(t || "").toLowerCase();
    totalLen += s.length;
    for (const w of words) {
      if (s.includes(w)) hits += 1;
    }
  }
  // 归一化到样本条数：命中越密分越高
  const per = texts.length ? hits / texts.length : 0;
  const lenBonus = totalLen > 400 ? 6 : 0;
  return clamp100(base + per * perHit + lenBonus);
}

function questionScore(texts) {
  let q = 0;
  for (const t of texts) {
    const s = String(t || "");
    if (s.includes("?") || s.includes("？")) q += 1;
  }
  return texts.length ? q / texts.length : 0;
}

function emojiScore(texts) {
  let e = 0;
  for (const t of texts) {
    if (EMOJI_RE.test(String(t || ""))) e += 1;
  }
  return texts.length ? e / texts.length : 0;
}

// 叠加前端传来的风格选择次数（插件记录），温和拉高对应维度
// 插件记录的是“发言风格”键（rational/troll/…），需映射到 6 项能力键才能加权。
// 之前直接用能力键读 styleTally 恒为 undefined → 加权是 no-op，此处修正。
const STYLE_TO_STATS = {
  rational: ["logic", "armor"],
  troll: ["venom", "attack"],
  deflect: ["armor"],
  mock: ["venom", "humor"],
  deescalate: ["armor", "resilience"],
  support: ["resilience", "humor"],
};
function applyTally(valueMap, styleTally) {
  if (!styleTally || typeof styleTally !== "object") return valueMap;
  const out = { ...valueMap };
  for (const [style, targets] of Object.entries(STYLE_TO_STATS)) {
    const n = Number(styleTally[style]);
    if (Number.isFinite(n) && n > 0) {
      const bonus = Math.min(n * 2, 20); // 次数越多越偏好，封顶 +20
      for (const stat of targets) out[stat] = clamp100((out[stat] || 0) + bonus);
    }
  }
  return out;
}

// ── 启发式主体 ────────────────────────────────────────────────────
function heuristicProfile({ texts, styleTally }) {
  const list = Array.isArray(texts) ? texts.filter((t) => String(t || "").trim()) : [];

  if (list.length === 0) {
    // 新人默认低分档案
    const valueMap = { attack: 20, venom: 15, logic: 25, armor: 20, resilience: 30, humor: 25 };
    const merged = applyTally(valueMap, styleTally);
    return {
      standName: "《无名新星》",
      summary: "还没留下多少发言样本，替身尚在孕育中。多在情景模拟、赏金和评论区发声，面板才会逐渐显形。",
      catchphrases: NEWCOMER_PHRASES.slice(),
      stats: buildStats(merged),
      heuristic: true,
    };
  }

  const attack = densityScore(list, ATTACK_WORDS, 40, 25);
  const venom = densityScore(list, VENOM_WORDS, 42, 18);
  const logicBase = densityScore(list, LOGIC_WORDS, 38, 28);
  const logic = clamp100(logicBase + questionScore(list) * 20);
  const armor = densityScore(list, ARMOR_WORDS, 40, 22);
  const humor = clamp100(densityScore(list, HUMOR_WORDS, 36, 24) + emojiScore(list) * 25);
  // 抗压：叠甲越少、攻击/嘴臭越高，抗压越强；给一个组合估计
  const resilience = clamp100(35 + attack * 0.25 + venom * 0.2 - armor * 0.15);

  const valueMap = applyTally({ attack, venom, logic, armor, resilience, humor }, styleTally);
  const standName = pickStandName(valueMap);

  const top = STAT_KEYS.reduce((a, b) => (valueMap[b] > valueMap[a] ? b : a), STAT_KEYS[0]);
  const summary = `根据 ${list.length} 条发言，你的替身在「${STAT_LABEL[top]}」上格外突出。${
    valueMap.armor >= 60 ? "习惯先叠甲再开火，攻守兼备。" : "说话相对直接，火力全开。"
  }${valueMap.humor >= 60 ? "还时不时整点幽默，气氛担当。" : ""}`;

  const catchphrases = [];
  if (attack >= 55) catchphrases.push("你这逻辑站得住吗？");
  if (venom >= 55) catchphrases.push("就这？");
  if (logic >= 55) catchphrases.push("首先，我们看数据");
  if (armor >= 55) catchphrases.push("先叠个甲，个人观点");
  if (humor >= 55) catchphrases.push("哈哈哈笑死");
  if (resilience >= 55) catchphrases.push("随便喷，我无所谓");
  while (catchphrases.length < 3) {
    const fill = ["行吧", "有一说一", "不敢苟同", "点到为止"][catchphrases.length % 4];
    if (!catchphrases.includes(fill)) catchphrases.push(fill);
    else break;
  }

  return {
    standName,
    summary,
    catchphrases: catchphrases.slice(0, 6),
    stats: buildStats(valueMap),
    heuristic: true,
  };
}

// ── OpenAI 分析 ───────────────────────────────────────────────────
async function openAiProfile({ texts, styleTally }) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const list = Array.isArray(texts) ? texts.filter((t) => String(t || "").trim()) : [];

  const sampleBlock = list
    .slice(0, 60)
    .map((t, i) => `${i + 1}. ${String(t).slice(0, 200)}`)
    .join("\n");

  const tallyBlock =
    styleTally && typeof styleTally === "object" && Object.keys(styleTally).length
      ? `\n用户在插件里主动选择过的风格倾向（次数越多代表越偏好，可作为参考权重）：${JSON.stringify(styleTally)}`
      : "";

  const prompt = `
你是一个"发言风格分析师"。下面是某个用户在社区里（情景模拟辩论、赏金发言、评论区）留下的发言样本。请像给 JOJO 替身做能力面板那样，分析这个人的说话风格。

请评估以下 6 项固定能力，每项打 0-100 分：
- attack（攻击力：主动进攻、直接开怼的强度）
- venom（嘴臭指数：阴阳怪气、讥讽、毒舌的程度）
- logic（逻辑性：讲依据、摆数据、条理清晰的程度）
- armor（叠甲熟练度：说话前"先声明立场/免责/仅代表个人"的娴熟度）
- resilience（抗压能力：面对反驳与冲突时的稳定与不破防）
- humor（幽默感：玩梗、搞笑、活跃气氛的能力）

再给这个人起一个中二的"替身名"（standName，用书名号包裹，如《白金之嘴》《黄金体验·杠精》），写一段 2-3 句的中文点评（summary），并提炼 3-6 条这个用户的口头禅/风格短语（catchphrases）。

发言样本（共 ${list.length} 条）：
${sampleBlock || "（暂无样本）"}${tallyBlock}

只返回 STRICT JSON，形如：
{
  "standName": "《……》",
  "summary": "……",
  "catchphrases": ["……", "……", "……"],
  "stats": { "attack": 0, "venom": 0, "logic": 0, "armor": 0, "resilience": 0, "humor": 0 }
}
所有文本用中文。不要输出 JSON 以外的任何内容。
`;

  const resp = await client.responses.create({ model, input: prompt });
  const text = resp.output_text || "";
  const payload = parseJsonObject(text);

  if (!payload || !payload.stats || typeof payload.stats !== "object") {
    // 模型没给出可用结果：兜底启发式（但保留 heuristic 语义）
    return heuristicProfile({ texts, styleTally });
  }

  const valueMap = {};
  for (const key of STAT_KEYS) valueMap[key] = clamp100(payload.stats[key]);

  const standName =
    typeof payload.standName === "string" && payload.standName.trim()
      ? payload.standName.trim().slice(0, 120)
      : pickStandName(valueMap);

  const summary =
    typeof payload.summary === "string" && payload.summary.trim()
      ? payload.summary.trim().slice(0, 2000)
      : "";

  const catchphrases = Array.isArray(payload.catchphrases)
    ? payload.catchphrases
        .map((c) => String(c || "").trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];

  return {
    standName,
    summary,
    catchphrases,
    stats: buildStats(valueMap),
    model,
  };
}

// ── 对外导出 ──────────────────────────────────────────────────────
async function generateStyleProfile({ texts, styleTally } = {}) {
  if (!hasKey()) {
    return heuristicProfile({ texts, styleTally });
  }
  try {
    return await openAiProfile({ texts, styleTally });
  } catch {
    // 任意错误都兜底到启发式，保证无 key/异常也能端到端演示，绝不抛 501
    return heuristicProfile({ texts, styleTally });
  }
}

module.exports = { generateStyleProfile };
