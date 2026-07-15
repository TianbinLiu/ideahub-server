// src/services/standpointAi.service.js
// 立场展开 AI 服务：对一条来消息做「分类 + 按立场/人格/知识库生成回复」。
// 有 OPENAI_API_KEY → 用 OpenAI；无 key → 本地启发式（reply.heuristic=true），绝不抛 501。
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

const CLASSIFICATIONS = ["malicious", "question", "request", "other"];
const STANCES = ["aggressive", "peaceful", "rational", "sarcastic"];
const STANCE_LABEL = {
  aggressive: "激进强硬",
  peaceful: "和平克制",
  rational: "理性讲理",
  sarcastic: "阴阳怪气",
};

function normalizeStance(s) {
  return STANCES.includes(s) ? s : "rational";
}

// ── 启发式分类 ────────────────────────────────────────────────────
const MALICIOUS_WORDS = [
  "傻", "蠢", "nc", "脑残", "智障", "垃圾", "滚", "废物", "sb", "傻逼", "弱智",
  "也配", "恶心", "有病", "神经病", "脑瘫", "狗东西", "贱", "蟑螂", "恶臭", "闭嘴",
];
const QUESTION_WORDS = [
  "?", "？", "为什么", "怎么", "请问", "如何", "咋", "是不是", "能不能", "多少", "哪里", "什么时候",
];
const REQUEST_WORDS = [
  "加群", "加入", "入群", "合作", "求", "报名", "联系", "带我", "收徒", "投稿", "私信我", "一起", "组队",
];

// 纯英文缩写（nc/sb 等）用词边界匹配，避免误伤 dance/since/husband/USB 等正常词
function hitsMalicious(t, w) {
  if (/^[a-z]+$/.test(w)) return new RegExp(`\\b${w}\\b`).test(t);
  return t.includes(w);
}

function heuristicClassify(text) {
  const t = String(text || "").toLowerCase();
  if (MALICIOUS_WORDS.some((w) => hitsMalicious(t, w))) return "malicious";
  if (QUESTION_WORDS.some((w) => t.includes(w))) return "question";
  if (REQUEST_WORDS.some((w) => t.includes(w))) return "request";
  return "other";
}

// ── 启发式回复模板 ────────────────────────────────────────────────
function heuristicMaliciousReply(stance) {
  switch (stance) {
    case "aggressive":
      return "就这？光会骂人可说明不了你有理。有本事把论据摆出来，别在这儿刷存在感——这种挑衅我原样奉还，不奉陪也绝不认输。";
    case "peaceful":
      return "我理解你可能有情绪，但这样攻击并不能解决问题。如果你有具体不满，欢迎心平气和地说清楚，我很乐意认真回应。";
    case "rational":
      return "你的说法缺少论据。我们就事论事：你到底不认同哪一点？把理由列出来，我可以逐条回应，人身攻击就不必了。";
    case "sarcastic":
      return "哟，这么大火气，看来是被戳到痛处了呢。这么闲还专门来骂人，不如省点力气去充实一下自己，下次说不定能讲出点道理～";
    default:
      return "有意见可以讲道理，人身攻击就免了。";
  }
}

function heuristicHelpfulReply(stance, personalInfo) {
  const info = String(personalInfo || "").trim();
  const body = info
    ? `根据我这边的资料：${info.slice(0, 300)}`
    : "相关信息我一般会放在主页/置顶说明，可以留意一下";
  const opener = stance === "sarcastic" ? "难得有人好好问，" : "谢谢关注！";
  return `${opener}${body}。还有其他问题也可以直接问我～`;
}

function heuristicNeutralReply() {
  return "收到，谢谢你的留言～有具体问题可以随时告诉我。";
}

function buildHeuristicReply({ classification, config }) {
  const stance = normalizeStance(config && config.stance);
  let text;
  if (classification === "malicious") {
    text = heuristicMaliciousReply(stance);
  } else if (classification === "question" || classification === "request") {
    text = heuristicHelpfulReply(stance, config && config.personalInfo);
  } else {
    text = heuristicNeutralReply();
  }
  return { text, style: stance, heuristic: true };
}

function heuristicClassifyAndReply({ incomingText, config }) {
  const classification = heuristicClassify(incomingText);
  return { classification, reply: buildHeuristicReply({ classification, config }) };
}

// ── OpenAI 分类 + 生成 ────────────────────────────────────────────
async function openAiClassifyAndReply({ incomingText, kind, config }) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const stance = normalizeStance(config && config.stance);
  const stanceLabel = STANCE_LABEL[stance];
  const persona = String((config && config.personaText) || "").slice(0, 1000);
  const personalInfo = String((config && config.personalInfo) || "").slice(0, 2000);
  const kindLabel = kind === "dm" ? "私信" : "评论回复";

  const prompt = `
你是一个社交媒体账号的"立场展开"自动应答代理。有人给账号主发来了一条${kindLabel}，你需要：
1) 先把这条消息分类为四类之一：
   - malicious（恶意攻击/挑衅/辱骂/带节奏）
   - question（提问/咨询）
   - request（请求/诉求，如加群、合作、求助）
   - other（其它，普通留言/寒暄）
2) 再以账号主的口吻生成一条中文回复。

账号主设定的回应立场（stance）：${stanceLabel}
账号主的人格描述：${persona || "（未填写，用自然口吻即可）"}
账号主的个人信息/知识库（用于回答提问与请求，例如粉丝群怎么加、专业问题等）：${personalInfo || "（未填写）"}

回复要求：
- 若为 malicious：按「${stanceLabel}」的风格回击。aggressive→强硬直接地怼回去；peaceful→克制、化解、不升级；rational→摆事实讲道理、指出对方逻辑问题；sarcastic→阴阳怪气、以讥讽还击。不使用违法或露骨的人身攻击。
- 若为 question 或 request：优先用上面的"个人信息/知识库"给出有用、具体的回答；信息不足时给出合理、友善的引导。
- 若为 other：给一条中性、简短、友好的回复。
- 中文输出，口语化，符合账号主人格。

这条消息内容：
${String(incomingText || "").slice(0, 1000)}

只返回 STRICT JSON，形如：
{ "classification": "malicious|question|request|other", "reply": { "text": string } }
不要输出 JSON 以外的任何内容。
`;

  const resp = await client.responses.create({ model, input: prompt });
  const text = resp.output_text || "";
  const payload = parseJsonObject(text);

  const classification =
    payload && CLASSIFICATIONS.includes(payload.classification)
      ? payload.classification
      : heuristicClassify(incomingText);

  const replyText =
    payload && payload.reply && typeof payload.reply.text === "string"
      ? payload.reply.text.trim()
      : "";

  if (!replyText) {
    // 模型没给出可用回复：兜底到启发式回复，但保留分类结果
    return { classification, reply: buildHeuristicReply({ classification, config }) };
  }

  return {
    classification,
    reply: { text: replyText.slice(0, 2000), style: stance, model },
  };
}

// ── 对外导出 ──────────────────────────────────────────────────────
async function classifyAndReply({ incomingText, kind, config }) {
  if (!hasKey()) {
    return heuristicClassifyAndReply({ incomingText, config });
  }
  try {
    return await openAiClassifyAndReply({ incomingText, kind, config });
  } catch {
    // 任意错误都兜底到启发式，保证无 key/异常也能端到端演示，绝不抛 501
    return heuristicClassifyAndReply({ incomingText, config });
  }
}

module.exports = { classifyAndReply };
