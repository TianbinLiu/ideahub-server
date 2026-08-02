// src/models/BranchDeck.js
// 分支视频 · 卡组：用户把自己的卡片编成组，工坊里整组拖进场景。
// cardIds 存的是 BranchCard.cardId（客户端稳定 id 字符串），不是 ObjectId——
// 卡片删除时由控制器 $pull 出所有卡组，保证不留悬空引用。
// ★ Mongoose 9 的 pre hook 不接收 next——本模型刻意不写任何 hook。
const mongoose = require("mongoose");

const branchDeckSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    cardIds: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false }
);

branchDeckSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("BranchDeck", branchDeckSchema);
