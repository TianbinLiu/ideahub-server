// src/models/CompanionSetting.js
// 每个用户给「数字人」（官网首页看板娘 + App AI 客服，同一个形象）做的三项选择：
//   persona —— 人格市场里的人格（说话风格进 LLM 提示词，人格自带的嗓子进 TTS）
//   model   —— Live2D 模型市场里的模型（null = 官方内置的看板娘）
//   voice   —— 用户自己拧的豆包音频参数（覆盖人格/模型自带的，见 utils/voiceSettings.js 的合并顺序）
//
// 只存 id，不存快照：人格作者改了风格、模型作者换了默认嗓子，用户这边跟着变（与情景绑定人格同一语义）；
// 被删 / 取消分享 → 读取时静默回退到默认（不报错、不挡聊天）。
// ★ voice 是唯一的例外：混音配方（mix）是**快照**而不是对模板的引用——嗓子是用户听过才定下来的，
//   模板作者事后改配方 / 删模板都不该让别人的数字人突然变声。templateId 只用来在市场里标「使用中」。
// 与 PersonaEquip（Arena 发言风格的装备）是两回事：那是浏览器插件生成方案用的，这里是数字人。
const mongoose = require("mongoose");

/** 混音配方的一味：1.0 音色 + 归一化后的权重（和 = 1，三位小数；见 utils/voiceSettings.normalizeMix） */
const voiceMixEntrySchema = new mongoose.Schema(
  {
    voiceId: { type: String, required: true, maxlength: 64 },
    weight: { type: Number, required: true, min: 0, max: 1 },
  },
  { _id: false }
);

/** 被 Persona.voice / Live2dModel.voice / CompanionSetting.voice 三处复用的音频设置子文档 */
const voiceSettingsSchema = new mongoose.Schema(
  {
    voiceId: { type: String, default: "", maxlength: 64 },
    // 1～3 味 1.0 音色的混音配方；null = 单音色（用 voiceId）。有 mix 时 voiceId 被忽略
    mix: { type: [voiceMixEntrySchema], default: null },
    // 配方来自声音市场的哪个模板（VoiceTemplate）；模板被删时置 null，配方本身不动
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "VoiceTemplate", default: null },
    rate: { type: Number, default: null, min: -50, max: 100 },
    pitch: { type: Number, default: null, min: -12, max: 12 },
    instruct: { type: String, default: "", maxlength: 200 },
    expressive: { type: Boolean, default: true },
  },
  { _id: false }
);

const companionSettingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", default: null },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "Live2dModel", default: null },
    voice: { type: voiceSettingsSchema, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CompanionSetting", companionSettingSchema);
module.exports.voiceSettingsSchema = voiceSettingsSchema;
module.exports.voiceMixEntrySchema = voiceMixEntrySchema;
