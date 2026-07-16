// src/models/PersonaEquip.js
// 当前装备的人格（每个用户一条）。persona=null 表示切回本人风格。
const mongoose = require("mongoose");

const personaEquipSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PersonaEquip", personaEquipSchema);
