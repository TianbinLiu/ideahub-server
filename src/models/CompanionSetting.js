// src/models/CompanionSetting.js
// 每个用户给「数字人」（官网首页看板娘 + App AI 客服，同一个形象）做的三项选择：
//   persona —— 人格市场里的人格（说话风格进 LLM 提示词，人格自带的嗓子进 TTS）
//   model   —— Live2D 模型市场里的模型（null = 官方内置的看板娘）
//   voice   —— 用户自己拧的豆包音频参数（覆盖人格/模型自带的，见 utils/voiceSettings.js 的合并顺序）
//
// 只存 id，不存快照：人格作者改了风格、模型作者换了默认嗓子，用户这边跟着变（与情景绑定人格同一语义）；
// 被删 / 取消分享 → 读取时静默回退到默认（不报错、不挡聊天）。
// 与 PersonaEquip（Arena 发言风格的装备）是两回事：那是浏览器插件生成方案用的，这里是数字人。
const mongoose = require("mongoose");

const voiceSettingsSchema = new mongoose.Schema(
  {
    voiceId: { type: String, default: "", maxlength: 64 },
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
