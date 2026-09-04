// src/models/VoiceTemplate.js
// 声音市场的一条「混音模板」：1～3 味豆包 1.0 音色按权重调出来的一把嗓子，外加作者顺手定好的
// 语速 / 音高 / 语调指令。用户在市场里试听、点赞、「使用」——使用 = 把配方**快照**进自己的
// CompanionSetting.voice（或人格 / 模型的 voice），只留 templateId 标记来源。
//
// ★ 为什么是快照而不是引用（与 persona / model 的「只存 id」相反）：嗓子是听过才定下来的，模板作者
//   事后改配方或删模板，都不该让别人的数字人突然变声。所以删模板只把引用方的 templateId 置 null
//   （见 services/voiceTemplate.service.detachTemplateEverywhere），配方原样留着。
// ★ recipe 只收 config/voices.js 的 MIXABLE_VOICES（23 个验证过的 1.0 音色）：2.0 混不了（55000000），
//   目录外的 1.0 id 没验证过能不能出声——写入路径由 schemas/voiceTemplate.schemas.js 的 zod 挡成 400。
const mongoose = require("mongoose");
const { voiceMixEntrySchema } = require("./CompanionSetting");

const voiceTemplateSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    // 归一化后的配方：权重之和 = 1、三位小数（utils/voiceSettings.normalizeMix）
    recipe: { type: [voiceMixEntrySchema], required: true },
    rate: { type: Number, default: null, min: -50, max: 100 },
    pitch: { type: Number, default: null, min: -12, max: 12 },
    // 1.0 音色不吃 context_texts，这两项只是随配方一起快照过去，等用户换回 2.0 单音色时还在
    instruct: { type: String, default: "", maxlength: 200 },
    expressive: { type: Boolean, default: true },
    shared: { type: Boolean, default: false, index: true },
    stats: {
      // useCount 由 POST /:id/use 计（前端应用模板时调一次），不要求幂等
      useCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

voiceTemplateSchema.index({ shared: 1, createdAt: -1 });
voiceTemplateSchema.index({ shared: 1, "stats.useCount": -1 });

module.exports = mongoose.model("VoiceTemplate", voiceTemplateSchema);
