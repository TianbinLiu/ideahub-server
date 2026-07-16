// src/models/MemeCollect.js
// 表情/梗图收藏关系（collectCount 的来源）。{user,meme} 唯一复合索引。
const mongoose = require("mongoose");

const memeCollectSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    meme: { type: mongoose.Schema.Types.ObjectId, ref: "Meme", required: true, index: true },
  },
  { timestamps: true }
);

memeCollectSchema.index({ user: 1, meme: 1 }, { unique: true });

module.exports = mongoose.model("MemeCollect", memeCollectSchema);
