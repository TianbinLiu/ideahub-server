// src/models/Persona.js
// 人格下载（Persona）——用户把自己的发言风格（来自阶段5 SpeakingProfile）发布为可分享的「人格」。
// 其他用户可浏览/下载收藏/点赞/装备；装备后驱动浏览器插件在其它平台生成三条方案。
const mongoose = require("mongoose");

// 风格能力子文档（复用阶段5 StyleStat 形状：key/label/value/grade）
const personaStatSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, default: "" },
    value: { type: Number, default: 0, min: 0, max: 100 },
    grade: { type: String, default: "E" },
  },
  { _id: false }
);

// 人格风格子文档
const personaStyleSchema = new mongoose.Schema(
  {
    summary: { type: String, default: "", maxlength: 2000 },
    catchphrases: { type: [String], default: [] },
    stats: { type: [personaStatSchema], default: [] },
    stanceHint: { type: String, default: "", maxlength: 500 },
  },
  { _id: false }
);

const personaSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: "", trim: true, maxlength: 1000 },
    coverEmoji: { type: String, default: "🎭", trim: true, maxlength: 8 },
    // 可选图片封面（Cloudinary URL）：有值时优先于 coverEmoji 展示，空串 = 用 emoji
    coverImageUrl: { type: String, default: "" },
    tags: { type: [String], default: [] },
    style: { type: personaStyleSchema, default: () => ({}) },
    shared: { type: Boolean, default: false, index: true },
    // 售价（虚拟点数，整数；0=免费）。>0 时其他用户需购买（PersonaPurchase）才能
    // 【选用】：绑进情景 / 装备。收藏（install）保持免费——那只是书签。
    // 私有人格存价无意义但无害：只在 shared 时展示与生效。
    price: { type: Number, default: 0, min: 0, max: 100000 },
    stats: {
      viewCount: { type: Number, default: 0 },
      downloadCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

personaSchema.index({ shared: 1, createdAt: -1 });
personaSchema.index({ shared: 1, "stats.downloadCount": -1 });

module.exports = mongoose.model("Persona", personaSchema);
