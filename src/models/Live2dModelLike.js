// src/models/Live2dModelLike.js
// Live2D 模型点赞关系（likeCount 的来源）。{user,model} 唯一复合索引，与 PersonaLike 同款。
const mongoose = require("mongoose");

const live2dModelLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    model: { type: mongoose.Schema.Types.ObjectId, ref: "Live2dModel", required: true, index: true },
  },
  { timestamps: true }
);

live2dModelLikeSchema.index({ user: 1, model: 1 }, { unique: true });

module.exports = mongoose.model("Live2dModelLike", live2dModelLikeSchema);
