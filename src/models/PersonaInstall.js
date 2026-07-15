// src/models/PersonaInstall.js
// 人格收藏/下载关系（downloadCount 的来源）。{user,persona} 唯一复合索引。
const mongoose = require("mongoose");

const personaInstallSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", required: true, index: true },
  },
  { timestamps: true }
);

personaInstallSchema.index({ user: 1, persona: 1 }, { unique: true });

module.exports = mongoose.model("PersonaInstall", personaInstallSchema);
