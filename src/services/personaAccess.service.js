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

/** 与 persona.controller.computeStyleDescriptor 同一份拼法（那边不便 require 进 service，复制一份并加测试钉住） */
function styleDescriptorOf(name, style) {
  const summary = String(style?.summary || "").trim();
  const catchphrases = Array.isArray(style?.catchphrases) ? style.catchphrases.filter(Boolean) : [];
  const stanceHint = String(style?.stanceHint || "").trim();
  const parts = [String(name || "").trim()];
  if (summary) parts.push(`风格：${summary}`);
  if (catchphrases.length) parts.push(`口头禅：${catchphrases.join("、")}`);
  if (stanceHint) parts.push(`倾向：${stanceHint}`);
  return parts.join("｜").slice(0, 600);
}

/**
 * 判定 + 取回人格（lean）。
 * @returns {Promise<{ persona: object|null, reason: ""|"not_found"|"private"|"unpaid" }>}
 */
async function checkPersonaAccess(personaId, userId) {
  const id = String(personaId || "");
  if (!mongoose.isValidObjectId(id)) return { persona: null, reason: "not_found" };
  const persona = await Persona.findById(id).populate("author", "_id username").lean();
  if (!persona) return { persona: null, reason: "not_found" };
  const authorId = String(persona.author?._id || persona.author);
  const isOwner = !!userId && authorId === String(userId);
  if (!persona.shared && !isOwner) return { persona: null, reason: "private" };
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
    voice: serializeVoiceSettings(doc.voice),
    price: Number(doc.price || 0),
    shared: !!doc.shared,
    author: doc.author && typeof doc.author === "object" ? { _id: doc.author._id, username: doc.author.username } : doc.author || null,
  };
}

module.exports = { styleDescriptorOf, checkPersonaAccess, loadUsablePersona, personaSummary };
