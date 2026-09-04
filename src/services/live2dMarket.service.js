/**
 * @file live2dMarket.service.js - Live2D 模型市场的序列化、官方内置条目、可用性判定
 * @category Service
 *
 * 被 live2dModel.controller（市场接口）与 companionSetting.service（数字人设置）两边共用：
 * 「用户选了哪个模型」最终要回给两种前端同一形状的 Live2dModelPayload。
 *
 * ★ 官方内置的看板娘不是库里的一条记录：它随官网与 App 打包（/live2d/mascot/mascot.model3.json），
 *   这里用固定 id `official-mascot` 表示，modelJsonUrl 留空 —— 前端拿到空串就用自己那份本地文件，
 *   服务端不知道也不该知道客户端把模型放在哪。列表第一页把它排在最前面，方便"换回默认"。
 */
const mongoose = require("mongoose");
const Live2dModel = require("../models/Live2dModel");
const { personaSummary } = require("./personaAccess.service");
const { serializeVoiceSettings } = require("../utils/voiceSettings");
const { publicUrlFor } = require("./live2dBundle.service");
const { DEFAULT_NAME } = require("./companion.service");

const OFFICIAL_MODEL_ID = "official-mascot";

function companionName() {
  return String(process.env.COMPANION_NAME || "").trim() || DEFAULT_NAME;
}

function isOfficialId(id) {
  return String(id || "") === OFFICIAL_MODEL_ID;
}

function officialModelPayload() {
  return {
    _id: OFFICIAL_MODEL_ID,
    official: true,
    author: null,
    name: `${companionName()}（官方）`,
    description: "启梦官方看板娘，随官网与 App 内置，不用下载。",
    coverImageUrl: "",
    tags: ["官方"],
    modelJsonUrl: "",
    bundleName: "",
    bundleBytes: 0,
    fileCount: 0,
    persona: null,
    voice: null,
    shared: true,
    stats: { viewCount: 0, downloadCount: 0, likeCount: 0 },
    installed: true,
    liked: false,
    isOwner: false,
    createdAt: null,
    updatedAt: null,
  };
}

function authorIdOf(doc) {
  return String(doc?.author?._id || doc?.author || "");
}

/**
 * 序列化一条市场模型。persona 只有在【看的人能用】（公开、或就是人格作者）时才带出来，
 * 否则是 null —— 作者把私有人格绑进公开模型，别人用不了，列表里也别展示成"这模型自带 XX 人格"。
 */
function toLive2dModelPayload(doc, req, ctx = {}) {
  if (!doc) return null;
  const viewerId = ctx.viewerId ? String(ctx.viewerId) : "";
  const personaDoc = doc.persona && typeof doc.persona === "object" && doc.persona.name ? doc.persona : null;
  const personaUsable = personaDoc && (personaDoc.shared || (viewerId && String(personaDoc.author?._id || personaDoc.author) === viewerId));
  return {
    _id: doc._id,
    official: false,
    author: doc.author && typeof doc.author === "object" ? { _id: doc.author._id, username: doc.author.username } : doc.author,
    name: doc.name,
    description: doc.description || "",
    coverImageUrl: doc.coverImageUrl || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    modelJsonUrl: doc.modelJsonPath ? publicUrlFor(req, doc.modelJsonPath) : "",
    bundleName: doc.bundleName || "",
    bundleBytes: Number(doc.bundleBytes || 0),
    fileCount: Number(doc.fileCount || 0),
    persona: personaUsable ? personaSummary(personaDoc) : null,
    voice: serializeVoiceSettings(doc.voice),
    shared: !!doc.shared,
    stats: {
      viewCount: Number(doc?.stats?.viewCount || 0),
      downloadCount: Number(doc?.stats?.downloadCount || 0),
      likeCount: Number(doc?.stats?.likeCount || 0),
    },
    installed: !!ctx.installed,
    liked: !!ctx.liked,
    isOwner: !!viewerId && authorIdOf(doc) === viewerId,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** 用户能不能【使用】这个模型：公开的，或自己上传的。找不到 / 私有他人的 → null */
async function loadUsableModel(modelId, userId) {
  const id = String(modelId || "");
  if (!mongoose.isValidObjectId(id)) return null;
  const doc = await Live2dModel.findById(id).populate("author", "_id username").populate("persona").lean();
  if (!doc) return null;
  if (!doc.shared && (!userId || authorIdOf(doc) !== String(userId))) return null;
  return doc;
}

module.exports = { OFFICIAL_MODEL_ID, isOfficialId, officialModelPayload, toLive2dModelPayload, loadUsableModel, authorIdOf, companionName };
