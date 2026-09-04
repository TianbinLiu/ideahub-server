/**
 * @file voiceSettings.js - 数字人「音频」设置（豆包 TTS 参数）的统一形状：校验、归一化、逐层合并
 * @category Utility
 *
 * 一份形状三处用：Persona.voice（人格自带的嗓子）、Live2dModel.voice（模型作者推荐的嗓子）、
 * CompanionSetting.voice（用户自己的覆盖）。合并顺序固定为 用户覆盖 > 人格 > 模型 > 服务端默认，
 * 每个字段独立取「第一个有值的」——用户只改了语速、人格只定了音色，两者都生效。
 *
 * 字段与 /api/tts 的 body 一一对应：voiceId→voice、rate→speech_rate、pitch→post_process.pitch、
 * instruct→context_texts（只对 2.0 音色生效）、expressive→seed-tts-2.0-expressive。
 */
const { z } = require("zod");

/** 与 tts.routes.js 的 safeId 同一套字符集：直接拼进上游 body 的东西一律先收口 */
const VOICE_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const INSTRUCT_MAX = 200;

const voiceSettingsSchema = z.object({
  voiceId: z.string().trim().max(64).regex(VOICE_ID_RE).or(z.literal("")).optional().default(""),
  rate: z.number().min(-50).max(100).nullable().optional().default(null),
  pitch: z.number().min(-12).max(12).nullable().optional().default(null),
  instruct: z.string().trim().max(INSTRUCT_MAX).optional().default(""),
  expressive: z.boolean().optional().default(true),
});

/** 请求体里 voice 可以是对象、null（清掉）或缺省（不改） */
const voiceFieldSchema = voiceSettingsSchema.nullable().optional();

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);

/**
 * 把任意输入收成标准形状；空对象/全空字段 → null（表示「没设置」，合并时整段跳过）。
 */
function normalizeVoiceSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const voiceId = typeof raw.voiceId === "string" && VOICE_ID_RE.test(raw.voiceId.trim()) ? raw.voiceId.trim() : "";
  const rate = num(raw.rate, -50, 100);
  const pitch = num(raw.pitch, -12, 12);
  const instruct = String(raw.instruct || "").trim().slice(0, INSTRUCT_MAX);
  const expressive = raw.expressive !== false;
  if (!voiceId && rate === null && pitch === null && !instruct) return null;
  return { voiceId, rate, pitch, instruct, expressive };
}

function serializeVoiceSettings(raw) {
  const v = normalizeVoiceSettings(raw);
  return v ? { ...v } : null;
}

/**
 * 逐字段合并，靠前的优先；最后一层是服务端默认（voiceId 取 COMPANION_TTS_VOICE，空串 = /api/tts 的内置默认）。
 * 返回值永远是完整对象，前端可以直接展开进 /api/tts 的 body。
 */
function resolveVoiceSettings(layers, { defaultVoiceId = "" } = {}) {
  const list = layers.map(normalizeVoiceSettings).filter(Boolean);
  const pick = (key, fallback) => {
    for (const layer of list) {
      const v = layer[key];
      if (v !== null && v !== undefined && v !== "") return v;
    }
    return fallback;
  };
  return {
    voiceId: pick("voiceId", String(defaultVoiceId || "").trim()),
    rate: pick("rate", null),
    pitch: pick("pitch", null),
    instruct: pick("instruct", ""),
    // expressive 是布尔：取最靠前一层的显式值
    expressive: list.length ? list[0].expressive : true,
  };
}

module.exports = {
  VOICE_ID_RE,
  INSTRUCT_MAX,
  voiceSettingsSchema,
  voiceFieldSchema,
  normalizeVoiceSettings,
  serializeVoiceSettings,
  resolveVoiceSettings,
};
