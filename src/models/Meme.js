// src/models/Meme.js
// 表情/梗图库（Meme）——用户在不同平台收藏表情/梗图，评论输入框旁的表情按钮打开面板搜索并插入。
// type='image' 用 imageUrl；type='text' 用 text（梗/短语）。shared=true 进公开素材库。
// collectCount 来源为 MemeCollect 计数；useCount 由插件插入时 $inc。
const mongoose = require("mongoose");

const memeSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    type: { type: String, enum: ["image", "text"], required: true },
    imageUrl: { type: String, default: "", trim: true, maxlength: 2000 },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    tags: { type: [String], default: [] },
    shared: { type: Boolean, default: false, index: true },
    stats: {
      collectCount: { type: Number, default: 0 },
      useCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

memeSchema.index({ shared: 1, createdAt: -1 });
memeSchema.index({ shared: 1, "stats.collectCount": -1 });

module.exports = mongoose.model("Meme", memeSchema);
