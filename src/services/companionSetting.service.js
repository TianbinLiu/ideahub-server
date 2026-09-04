/**
 * @file companionSetting.service.js - 数字人的三项选择（人格 / 模型 / 音频）读取、合并与写入
 * @category Service
 *
 * 官网首页看板娘（companion.routes）与 App AI 客服（support.routes）共用：两边是同一个形象、同一份设置。
 *
 * 合并规则（读取时现算，不存快照）：
 *   人格：用户选的 → 没选就用模型作者推荐的 → 都没有就是默认人设（提示词里不加人设段）
 *   音频：用户覆盖 > 人格自带 > 模型推荐 > 服务端默认（COMPANION_TTS_VOICE，空 = /api/tts 内置音色）
 *   模型：用户选的（公开或自己的）→ 否则官方内置
 * 选的东西被删 / 取消分享 / 变成付费而没买 → 静默回退到下一层，绝不让聊天报错。
 */
const CompanionSetting = require("../models/CompanionSetting");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { checkPersonaAccess, loadUsablePersona, personaSummary } = require("./personaAccess.service");
const { OFFICIAL_MODEL_ID, isOfficialId, loadUsableModel, toLive2dModelPayload, authorIdOf } = require("./live2dMarket.service");
const { resolveVoiceSettings, normalizeVoiceSettings, serializeVoiceSettings } = require("../utils/voiceSettings");

function defaultVoiceId() {
  return String(process.env.COMPANION_TTS_VOICE || "").trim();
}

/**
 * 读出某个用户的数字人设置并解析成前端可直接用的形状；userId 为空（游客）时只有服务端默认。
 * @returns {{ settings, persona, personaSource, model, voice }}
 */
async function loadCompanionSetup({ userId, req }) {
  const setting = userId ? await CompanionSetting.findOne({ user: userId }).lean() : null;
  const chosenPersona = setting?.persona ? await loadUsablePersona(setting.persona, userId) : null;
  const model = setting?.model ? await loadUsableModel(setting.model, userId) : null;
  // 模型作者推荐的人格：用户没自己选时顶上（同样要过可用性判定）
  const modelPersona = !chosenPersona && model?.persona ? await loadUsablePersona(model.persona?._id || model.persona, userId) : null;
  const persona = chosenPersona || modelPersona;
  const voice = resolveVoiceSettings([setting?.voice, persona?.voice, model?.voice], { defaultVoiceId: defaultVoiceId() });
  return {
    settings: {
      personaId: setting?.persona ? String(setting.persona) : null,
      modelId: setting?.model ? String(setting.model) : null,
      voice: serializeVoiceSettings(setting?.voice),
    },
    persona: personaSummary(persona),
    personaSource: chosenPersona ? "user" : modelPersona ? "model" : "",
    model: model ? toLive2dModelPayload(model, req, { viewerId: userId, installed: true }) : null,
    voice,
  };
}

/**
 * 写入（部分更新：缺省字段不动，null = 清掉）。
 * personaId 必须可选用（公开/自己的，付费的要已购），否则 403 PERSONA_NOT_AVAILABLE；
 * modelId 必须公开或自己的，"official-mascot"/null 都表示官方内置。
 */
async function updateCompanionSetting({ userId, req, patch }) {
  const $set = {};
  if (patch.personaId !== undefined) {
    if (patch.personaId === null || patch.personaId === "") {
      $set.persona = null;
    } else {
      const { persona, reason } = await checkPersonaAccess(patch.personaId, userId);
      if (!persona) {
        throw new AppError({
          code: reason === "not_found" ? CODES.NOT_FOUND : CODES.FORBIDDEN,
          status: reason === "not_found" ? 404 : 403,
          message: reason === "unpaid" ? "This persona must be purchased first" : reason === "private" ? "This persona is private" : "Persona not found",
          details: { reason },
        });
      }
      $set.persona = persona._id;
    }
  }
  if (patch.modelId !== undefined) {
    if (patch.modelId === null || patch.modelId === "" || isOfficialId(patch.modelId)) {
      $set.model = null;
    } else {
      const model = await loadUsableModel(patch.modelId, userId);
      if (!model) throw new AppError({ code: CODES.NOT_FOUND, status: 404, message: "Live2D model not found or not shared" });
      $set.model = model._id;
    }
  }
  if (patch.voice !== undefined) {
    $set.voice = patch.voice === null ? null : normalizeVoiceSettings(patch.voice);
  }
  if (Object.keys($set).length) {
    await CompanionSetting.findOneAndUpdate({ user: userId }, { $set, $setOnInsert: { user: userId } }, { upsert: true, new: true });
  }
  return loadCompanionSetup({ userId, req });
}

/** 装了人格时给 LLM 系统提示词加的一段（没装 → 空串，提示词与从前逐字相同） */
function personaPromptLine(persona) {
  if (!persona || !persona.styleDescriptor) return "";
  return `【人设】用户给你装了人格市场里的人格「${persona.name}」：${persona.styleDescriptor}。说话的语气、用词、口头禅必须贴合这个人设；但你的身份、职责与上面的所有规则不变。`;
}

module.exports = { OFFICIAL_MODEL_ID, loadCompanionSetup, updateCompanionSetting, personaPromptLine, defaultVoiceId, authorIdOf };
