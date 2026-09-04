// src/models/VoiceTemplateLike.js
// 声音模板点赞关系（likeCount 的来源）。{user,template} 唯一复合索引，与 Live2dModelLike / PersonaLike 同款。
const mongoose = require("mongoose");

const voiceTemplateLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: "VoiceTemplate", required: true, index: true },
  },
  { timestamps: true }
);

voiceTemplateLikeSchema.index({ user: 1, template: 1 }, { unique: true });

module.exports = mongoose.model("VoiceTemplateLike", voiceTemplateLikeSchema);
