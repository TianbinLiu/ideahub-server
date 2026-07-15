// src/models/PersonaLike.js
// 人格点赞关系（likeCount 的来源）。{user,persona} 唯一复合索引。
const mongoose = require("mongoose");

const personaLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", required: true, index: true },
  },
  { timestamps: true }
);

personaLikeSchema.index({ user: 1, persona: 1 }, { unique: true });

module.exports = mongoose.model("PersonaLike", personaLikeSchema);
