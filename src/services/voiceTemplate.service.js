/**
 * @file voiceTemplate.service.js - 声音市场（混音模板）的序列化、「{ templateId } → 快照」展开、删模板时的解引用
 * @category Service
 *
 * 被四处共用：voiceTemplate.controller（市场接口）、companionSetting.service（数字人设置）、
 * persona.controller / live2dModel.controller（人格 / 模型的「音频」板块）——凡是收 VoiceSettings 的写入口
 * 都走 expandVoiceInput：前端既可以直接给完整快照，也可以只给 `{ templateId }` 让服务端从模板展开。
 *
 * ★ 模板 → 用户是**快照**语义（与人格 / 模型的「只存 id」相反）：配方复制进引用方的 voice，只留 templateId
 *   标记来源。作者改配方 / 删模板都不会让别人的数字人变声；删模板只把引用方的 templateId 置 null。
 */
const mongoose = require("mongoose");
const VoiceTemplate = require("../models/VoiceTemplate");
const CompanionSetting = require("../models/CompanionSetting");
const Persona = require("../models/Persona");
const Live2dModel = require("../models/Live2dModel");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { normalizeVoiceSettings, serializeVoiceSettings, normalizeMix } = require("../utils/voiceSettings");

function authorIdOf(doc) {
  return String(doc?.author?._id || doc?.author || "");
}

/** 模板的音频快照：前端直接塞进 settings.voice / persona.voice / model.voice；templateId 指回模板本身 */
function voiceSnapshotOf(doc) {
  if (!doc) return null;
  return serializeVoiceSettings({
    voiceId: "",
    mix: doc.recipe,
    templateId: doc._id,
    rate: doc.rate,
    pitch: doc.pitch,
    instruct: doc.instruct,
    expressive: doc.expressive,
  });
}

/** 序列化一条模板（契约见 voiceTemplate.routes.js 文件头） */
function toVoiceTemplatePayload(doc, ctx = {}) {
  if (!doc) return null;
  const viewerId = ctx.viewerId ? String(ctx.viewerId) : "";
  return {
    _id: doc._id,
    author: doc.author && typeof doc.author === "object" ? { _id: doc.author._id, username: doc.author.username } : doc.author,
    name: doc.name,
    description: doc.description || "",
    recipe: normalizeMix(doc.recipe) || [],
    rate: typeof doc.rate === "number" ? doc.rate : null,
    pitch: typeof doc.pitch === "number" ? doc.pitch : null,
    instruct: doc.instruct || "",
    expressive: doc.expressive !== false,
    shared: !!doc.shared,
    stats: {
      useCount: Number(doc?.stats?.useCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
    },
    liked: !!ctx.liked,
    isOwner: !!viewerId && authorIdOf(doc) === viewerId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    voice: voiceSnapshotOf(doc),
  };
}

/**
 * 把请求里的 voice 变成可入库的快照（null = 没设置）：
 *   · 只给了 `{ templateId }`（没有 mix 也没有 voiceId）→ 从模板展开：recipe / rate / pitch / instruct / expressive 取模板的，
 *     templateId 指回模板；请求里显式带的 rate / pitch / instruct 覆盖模板的（「用这个模板，但快一点」）。
 *     模板不存在 404、私有且不是作者 403 —— 与选人格 / 选模型一样，写入时就拒绝，不留一个用不了的引用。
 *   · 其余（前端已经拿着完整快照，或只是单音色 / 只改语速）→ normalizeVoiceSettings。
 * @param {object|null|undefined} voice 已过 zod 的 voice 字段
 * @param {string|import("mongoose").Types.ObjectId} userId 写入者
 */
async function expandVoiceInput(voice, userId) {
  if (!voice || typeof voice !== "object") return null;
  const hasIdentity = (Array.isArray(voice.mix) && voice.mix.length > 0) || (typeof voice.voiceId === "string" && voice.voiceId.trim());
  if (hasIdentity || !voice.templateId) return normalizeVoiceSettings(voice);

  const id = String(voice.templateId);
  if (!mongoose.isValidObjectId(id)) throw new AppError({ code: CODES.INVALID_ID, status: 400, message: "Invalid voice template id" });
  const doc = await VoiceTemplate.findById(id).lean();
  if (!doc) throw new AppError({ code: CODES.NOT_FOUND, status: 404, message: "Voice template not found" });
  if (!doc.shared && authorIdOf(doc) !== String(userId || "")) {
    throw new AppError({ code: CODES.FORBIDDEN, status: 403, message: "This voice template is private" });
  }
  const snapshot = voiceSnapshotOf(doc) || {};
  return normalizeVoiceSettings({
    ...snapshot,
    rate: typeof voice.rate === "number" ? voice.rate : snapshot.rate,
    pitch: typeof voice.pitch === "number" ? voice.pitch : snapshot.pitch,
    instruct: typeof voice.instruct === "string" && voice.instruct.trim() ? voice.instruct : snapshot.instruct,
  });
}

/** 删模板：引用它的数字人设置 / 人格 / 模型只把 templateId 置 null，配方（快照）原样保留，用户的嗓子不变 */
async function detachTemplateEverywhere(templateId) {
  const filter = { "voice.templateId": templateId };
  const update = { $set: { "voice.templateId": null } };
  await Promise.all([CompanionSetting.updateMany(filter, update), Persona.updateMany(filter, update), Live2dModel.updateMany(filter, update)]);
}

module.exports = { authorIdOf, voiceSnapshotOf, toVoiceTemplatePayload, expandVoiceInput, detachTemplateEverywhere };
