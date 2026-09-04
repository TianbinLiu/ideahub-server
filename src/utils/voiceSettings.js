/**
 * @file voiceSettings.js - 数字人「音频」设置（豆包 TTS 参数）的统一形状：校验、归一化、逐层合并
 * @category Utility
 *
 * 一份形状三处用：Persona.voice（人格自带的嗓子）、Live2dModel.voice（模型作者推荐的嗓子）、
 * CompanionSetting.voice（用户自己的覆盖）。合并顺序固定为 用户覆盖 > 人格 > 模型 > 服务端默认。
 *
 * 字段分两类，合并规则不同：
 *  · 「声音身份」= mix（1～3 味 1.0 音色的混音配方）或 voiceId（单音色）。**整体取**：第一个带身份的层说了算，
 *    有 mix 时 voiceId 一律忽略（/api/tts 的 speaker 固定是 custom_mix_bigtts）。逐字段合并会把「用户层的 mix +
 *    人格层的 voiceId」拼成一对互相矛盾的字段，所以身份必须是原子的。
 *  · rate / pitch / instruct 逐字段取「第一个有值的」——用户只改了语速、人格只定了音色，两者都生效。
 *  · templateId 跟着身份走：记录这份配方来自声音市场的哪个模板（只做「使用中」展示；配方是快照，模板删了也不影响）。
 *
 * 字段与 /api/tts 的 body 一一对应：voiceId→voice、mix→mix、rate→speech_rate、pitch→post_process.pitch、
 * instruct→context_texts（只对 2.0 音色生效）、expressive→seed-tts-2.0-expressive。
 *
 * 混音的每一味必须在 config/voices.js 的 MIXABLE_VOICES（23 个验证过的 1.0 音色）里：写入路径靠这里的 zod
 * schema 挡成 400（message 说明只能混 1.0）；normalizeVoiceSettings 是读取路径也在用的「不报错」归一，
 * 目录外的 id 在那里只是被静默丢掉兜底。
 */
const { z } = require("zod");
const { isMixableVoice, MAX_MIX_VOICES } = require("../config/voices");

/** 与 tts.routes.js 的 safeId 同一套字符集：直接拼进上游 body 的东西一律先收口 */
const VOICE_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const INSTRUCT_MAX = 200;
/** 权重保留几位小数（豆包的 mix_factor 就是三位） */
const WEIGHT_DECIMALS = 3;

function mixOnlyV1Message(badIds) {
  return `混音只支持豆包 1.0 音色（*_moon_bigtts / *_mars_bigtts），2.0（uranus）混不了：${badIds.join("、")} 不在可混音目录里`;
}

/** 一味音色：{ voiceId, weight }；老形状 { id, w }（/api/tts 的早期调用方）也认，进来就转成新形状 */
const mixEntrySchema = z.preprocess(
  (v) => (v && typeof v === "object" && v.voiceId === undefined && v.id !== undefined ? { voiceId: v.id, weight: v.weight ?? v.w } : v),
  z.object({
    voiceId: z.string().trim().max(64).regex(VOICE_ID_RE),
    weight: z.number().positive(),
  }),
);

/**
 * 混音配方的 zod 校验：条数 min..3、每味形状合法、每味都在 1.0 可混音目录里（否则 custom issue，
 * middleware/error.js 会把这句人话当 message 回给前端）。
 * @param {{ min?: number }} [opts] VoiceSettings 的 mix 允许空数组（= 没有混音），模板的 recipe 至少 1 味
 */
function mixArraySchema({ min = 0 } = {}) {
  return z
    .array(mixEntrySchema)
    .min(min)
    .max(MAX_MIX_VOICES)
    .superRefine((list, ctx) => {
      const bad = [...new Set(list.map((m) => m.voiceId).filter((id) => !isMixableVoice(id)))];
      if (bad.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: mixOnlyV1Message(bad) });
    });
}

/** 模板 id：24 位 hex；空串 / null / 缺省都表示「没有」 */
const templateIdSchema = z
  .union([z.string().regex(OBJECT_ID_RE), z.literal(""), z.null()])
  .optional()
  .transform((v) => v || null);

const voiceSettingsSchema = z.object({
  voiceId: z.string().trim().max(64).regex(VOICE_ID_RE).or(z.literal("")).optional().default(""),
  mix: mixArraySchema().nullable().optional().default(null),
  templateId: templateIdSchema,
  rate: z.number().min(-50).max(100).nullable().optional().default(null),
  pitch: z.number().min(-12).max(12).nullable().optional().default(null),
  instruct: z.string().trim().max(INSTRUCT_MAX).optional().default(""),
  expressive: z.boolean().optional().default(true),
});

/** 请求体里 voice 可以是对象、null（清掉）或缺省（不改） */
const voiceFieldSchema = voiceSettingsSchema.nullable().optional();

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);

/**
 * 把任意形状的配方数组收成 [{ voiceId, weight }]：新形状 { voiceId, weight } 与老形状 { id, w } 都认，
 * 字符集收口 + 正权重；**不查目录、不截条数、不归一**（/api/tts 允许目录外的自定义音色，也走这里）。
 */
function parseMixEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const voiceId = String(m.voiceId ?? m.id ?? "").trim();
    const weight = Number(m.weight ?? m.w);
    if (!VOICE_ID_RE.test(voiceId) || !Number.isFinite(weight) || weight <= 0) continue;
    out.push({ voiceId, weight });
  }
  return out;
}

/**
 * 权重归一：和 = 1、每味 3 位小数。四舍五入的零头全记到最后一味——三味各 1/3 逐个 toFixed 是 0.999，
 * 而豆包要的是 mix_factor 之和**等于** 1。占比不到千分之一（归一后为 0）的那味等于没有，去掉重算。
 */
function normalizeWeights(entries) {
  let list = entries.filter((m) => Number.isFinite(m.weight) && m.weight > 0);
  for (;;) {
    const sum = list.reduce((a, m) => a + m.weight, 0);
    if (!list.length || !(sum > 0)) return [];
    const out = list.map((m) => ({ voiceId: m.voiceId, weight: +(m.weight / sum).toFixed(WEIGHT_DECIMALS) }));
    const head = out.slice(0, -1).reduce((a, m) => a + m.weight, 0);
    out[out.length - 1].weight = +(1 - head).toFixed(WEIGHT_DECIMALS);
    const dead = out.findIndex((m) => m.weight <= 0);
    if (dead === -1) return out;
    list = list.filter((_, i) => i !== dead);
  }
}

/**
 * 配方归一（不报错）：两种形状都认 → 只留 1.0 目录里的 → 同一音色合并权重 → 最多 3 味 → 权重归一。
 * 空 / 全无效 → null（= 没有混音）。
 */
function normalizeMix(raw) {
  const merged = new Map();
  for (const m of parseMixEntries(raw)) {
    if (!isMixableVoice(m.voiceId)) continue;
    merged.set(m.voiceId, (merged.get(m.voiceId) || 0) + m.weight);
  }
  const list = [...merged].slice(0, MAX_MIX_VOICES).map(([voiceId, weight]) => ({ voiceId, weight }));
  const out = normalizeWeights(list);
  return out.length ? out : null;
}

/**
 * 把任意输入收成标准形状；空对象/全空字段 → null（表示「没设置」，合并时整段跳过）。
 * 有 mix 时 voiceId 清空（存的就是干净的，前端不会看到一对矛盾字段）；没有 mix 就谈不上「来自哪个模板」，templateId 也清空。
 */
function normalizeVoiceSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mix = normalizeMix(raw.mix);
  const voiceId = !mix && typeof raw.voiceId === "string" && VOICE_ID_RE.test(raw.voiceId.trim()) ? raw.voiceId.trim() : "";
  const templateId = mix && raw.templateId && OBJECT_ID_RE.test(String(raw.templateId)) ? String(raw.templateId) : null;
  const rate = num(raw.rate, -50, 100);
  const pitch = num(raw.pitch, -12, 12);
  const instruct = String(raw.instruct || "").trim().slice(0, INSTRUCT_MAX);
  const expressive = raw.expressive !== false;
  if (!voiceId && !mix && rate === null && pitch === null && !instruct) return null;
  return { voiceId, mix, templateId, rate, pitch, instruct, expressive };
}

/** 对外输出永远带 mix 与 templateId（没有就 null） */
function serializeVoiceSettings(raw) {
  const v = normalizeVoiceSettings(raw);
  return v ? { ...v, mix: v.mix ? v.mix.map((m) => ({ ...m })) : null } : null;
}

/**
 * 合并，靠前的优先；最后一层是服务端默认（voiceId 取 COMPANION_TTS_VOICE，空串 = /api/tts 的内置默认）。
 * 声音身份（mix / voiceId / templateId）整体取自第一个带身份的层；rate / pitch / instruct 逐字段取。
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
  const identity = list.find((layer) => layer.mix || layer.voiceId) || null;
  return {
    voiceId: identity ? identity.voiceId : String(defaultVoiceId || "").trim(),
    mix: identity && identity.mix ? identity.mix.map((m) => ({ ...m })) : null,
    templateId: identity ? identity.templateId : null,
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
  MAX_MIX_VOICES,
  voiceSettingsSchema,
  voiceFieldSchema,
  mixArraySchema,
  parseMixEntries,
  normalizeWeights,
  normalizeMix,
  normalizeVoiceSettings,
  serializeVoiceSettings,
  resolveVoiceSettings,
};
