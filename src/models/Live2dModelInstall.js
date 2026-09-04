// src/models/Live2dModelInstall.js
// Live2D 模型的「下载/收藏」关系（downloadCount 的来源）。{user,model} 唯一复合索引，与 PersonaInstall 同款。
const mongoose = require("mongoose");

const live2dModelInstallSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "Live2dModel", required: true, index: true },
  },
  { timestamps: true }
);

live2dModelInstallSchema.index({ user: 1, model: 1 }, { unique: true });

module.exports = mongoose.model("Live2dModelInstall", live2dModelInstallSchema);
