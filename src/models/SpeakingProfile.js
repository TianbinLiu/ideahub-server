// src/models/SpeakingProfile.js
// 发言风格面板（Speaking Style Panel）——每个用户一张能力面板。
// AI（或启发式）汇总用户在情景模拟/赏金/评论区的发言，生成 6 项固定能力 + 点评。
const mongoose = require("mongoose");

// 6 项能力子文档（key 顺序固定；value 0-100；grade 由 value 派生）
const styleStatSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, default: "" },
    value: { type: Number, default: 0, min: 0, max: 100 },
    grade: { type: String, default: "E" },
  },
  { _id: false }
);

const speakingProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    summary: { type: String, default: "", maxlength: 2000 },
    catchphrases: { type: [String], default: [] },
    stats: { type: [styleStatSchema], default: [] },
    sampleCount: { type: Number, default: 0 },
    // 4c：插件记录的发言风格选择次数（styleKey -> 次数），纳入画像并可视化
    styleTally: { type: Object, default: {} },
    model: { type: String, default: "" },
    heuristic: { type: Boolean, default: false },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SpeakingProfile", speakingProfileSchema);
