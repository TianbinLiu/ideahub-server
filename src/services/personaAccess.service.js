/**
 * @file personaAccess.service.js - 「这个用户能不能选用这个人格」的唯一判定 + 给数字人用的人格摘要
 * @category Service
 *
 * 选用 = 绑进自己的数字人 / 情景 / 装备到插件。规则与 scenario.controller.resolveParticipantPersonas 一致：
 *   可见：persona.shared，或作者就是本人；
 *   付费：price > 0 且不是作者 → 必须有【已结算】的 PersonaPurchase（settledAt ≠ null，pending 不算）。
 * 收藏（PersonaInstall）不需要这些条件 —— 那只是书签。
 *
 * 数字人这边引用的是 id 而不是快照：人格被删 / 取消分享 / 作者把免费改成付费而用户没买，
 * `loadUsablePersona` 都返回 null，调用方静默回退到默认人设（不报错、不挡聊天）。
 */
const mongoose = require("mongoose");
const Persona = require("../models/Persona");
const PersonaPurchase = require("../models/PersonaPurchase");
const { serializeVoiceSettings } = require("../utils/voiceSettings");

/**
 * 人设文本的唯一拼法（persona.controller.computeStyleDescriptor 是它的别名；插件 personaText / 数字人【人设】段 / 试聊都用它）。
 * 2026-09-05 起多拼 语气 / 称呼用户 / 边界（向导生成的字段，老人格没有就不出现），上限 600 → 900 字。
 */
const STYLE_BUDGET = 900;
/** 句子边界（从后往前找，截在这些标点之后） */
const SENTENCE_END_RE = /[。！？；!?;]/g;
/**
 * 把一段话截到 limit 字以内、停在最后一个句子边界之后（找不到边界才退回逗号，再找不到才硬截）。
 * 截过的末尾不加「…」：这段是人设指令，模型读到省略号会把它当成语气的一部分。
 */
function cutAtSentence(text, limit) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  let at = -1;
  for (const m of head.matchAll(SENTENCE_END_RE)) at = m.index + 1;
  if (at < 0) {
    const comma = Math.max(head.lastIndexOf("，"), head.lastIndexOf(","));
    at = comma > 0 ? comma + 1 : -1; // 停在逗号之后，与句末同一个口径
  }
  return at > 0 ? head.slice(0, at) : head;
}
function styleDescriptorOf(name, style) {
  const summary = String(style?.summary || "").trim();
  const catchphrases = Array.isArray(style?.catchphrases) ? style.catchphrases.filter(Boolean) : [];
  const stanceHint = String(style?.stanceHint || "").trim();
  const tone = String(style?.tone || "").trim();
  const addressUser = String(style?.addressUser || "").trim();
  const boundaries = Array.isArray(style?.boundaries) ? style.boundaries.filter(Boolean) : [];
  // ★ 按预算整段取舍（2026-10-30，10-25 评审第 2 条）—— 原来是拼完 `.slice(0, 900)`：summary 一项就能到 2000 字，
  //   硬截会把句子切成半句，更要紧的是排在最后的「边界」（作者给这个人格定的不能聊什么）整段被切没。
  //   现在：放得下就逐字节与原来相同；放不下先**整段**丢优先级低的（倾向 → 口头禅 → 称呼用户 → 语气），
  //   「边界」与名字永远保留；还放不下就把「风格」在句子边界处截短。预算是模型读得完、提示词放得下的那个数，不是存储上限。
  const name0 = String(name || "").trim();
  const slots = [
    { key: "summary", text: summary ? `风格：${summary}` : "", drop: Infinity },
    { key: "tone", text: tone ? `语气：${tone}` : "", drop: 4 },
    { key: "catchphrases", text: catchphrases.length ? `口头禅：${catchphrases.join("、")}` : "", drop: 2 },
    { key: "stanceHint", text: stanceHint ? `倾向：${stanceHint}` : "", drop: 1 },
    { key: "addressUser", text: addressUser ? `称呼用户：${addressUser}` : "", drop: 3 },
    { key: "boundaries", text: boundaries.length ? `边界：${boundaries.join("；")}` : "", drop: Infinity },
  ].filter((x) => x.text);
  const join = () => [name0, ...slots.map((x) => x.text)].join("｜");
  if (join().length <= STYLE_BUDGET) return join();
  // 先整段丢可丢的（drop 小的先丢）
  const droppable = slots.filter((x) => Number.isFinite(x.drop)).sort((a, b) => a.drop - b.drop);
  for (const d of droppable) {
    if (join().length <= STYLE_BUDGET) break;
    slots.splice(slots.indexOf(d), 1);
  }
  // 再把「风格」在句子边界处截短（边界那一段与名字不动）
  const sum = slots.find((x) => x.key === "summary");
  if (sum && join().length > STYLE_BUDGET) {
    const others = join().length - sum.text.length;
    const room = STYLE_BUDGET - others - "风格：".length;
    if (room >= 20) sum.text = `风格：${cutAtSentence(summary, room)}`;
    else slots.splice(slots.indexOf(sum), 1);
  }
  // 兜底：边界本身就写满了（12 条 × 120 字）—— 从后往前整条去掉
  const bd = slots.find((x) => x.key === "boundaries");
  if (bd) {
    const list = [...boundaries];
    while (list.length > 1 && join().length > STYLE_BUDGET) {
      list.pop();
      bd.text = `边界：${list.join("；")}`;
    }
  }
  return join().slice(0, STYLE_BUDGET);
}

/**
 * 判定 + 取回人格（lean）。
 * @returns {Promise<{ persona: object|null, reason: ""|"not_found"|"private"|"unpaid"|"not_companion" }>}
 */
async function checkPersonaAccess(personaId, userId) {
  const id = String(personaId || "");
  if (!mongoose.isValidObjectId(id)) return { persona: null, reason: "not_found" };
  const persona = await Persona.findById(id).populate("author", "_id username").lean();
  if (!persona) return { persona: null, reason: "not_found" };
  const authorId = String(persona.author?._id || persona.author);
  const isOwner = !!userId && authorId === String(userId);
  if (!persona.shared && !isOwner) return { persona: null, reason: "private" };
  // 老师人格（kind:"tutor"）只有作者发布时勾了「同时发布为启梦人格 / 可装进看板娘」才能被选用（tutor 仓 docs/06 §5.1 反向勾选，2026-09-29 M3；
  //   与 personaKind.js 的列表过滤是同一条规则的两半：列表看得见 ⇔ 能装）。没勾的 style 是空的、装进去也没有人设；作者自己也不例外 ——
  //   这一格是「这位老师要不要进陪伴线」的表态，不是可见性。判否定：没这一格 = 没勾
  if (persona.kind === "tutor" && !(persona.companion && persona.companion.enabled === true)) return { persona: null, reason: "not_companion" };
  if (Number(persona.price || 0) > 0 && !isOwner) {
    const bought = userId
      ? await PersonaPurchase.exists({ user: userId, persona: persona._id, settledAt: { $ne: null } })
      : null;
    if (!bought) return { persona: null, reason: "unpaid" };
  }
  return { persona, reason: "" };
}

/** 可用就返回 lean 文档，否则 null（给"读取时静默回退"的场合） */
async function loadUsablePersona(personaId, userId) {
  if (!personaId) return null;
  const { persona } = await checkPersonaAccess(personaId, userId);
  return persona;
}

/** 数字人接口里的人格摘要（不带 stats/installed 那些市场字段） */
function personaSummary(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    name: doc.name,
    description: doc.description || "",
    coverEmoji: doc.coverEmoji || "🎭",
    coverImageUrl: doc.coverImageUrl || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    styleDescriptor: styleDescriptorOf(doc.name, doc.style),
    // 开场白 / 示例对话：数字人第一句用 greeting，聊天链路把 examples 当 few-shot（companion.service.personaExampleMessages）
    greeting: String(doc.style?.greeting || ""),
    examples: Array.isArray(doc.style?.examples)
      ? doc.style.examples.slice(0, 8).map((e) => ({ user: String(e?.user || ""), reply: String(e?.reply || "") }))
      : [],
    voice: serializeVoiceSettings(doc.voice),
    price: Number(doc.price || 0),
    shared: !!doc.shared,
    author: doc.author && typeof doc.author === "object" ? { _id: doc.author._id, username: doc.author.username } : doc.author || null,
  };
}

module.exports = { styleDescriptorOf, checkPersonaAccess, loadUsablePersona, personaSummary };
