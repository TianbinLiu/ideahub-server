// src/models/BranchDeck.js
// 分支视频 · 卡组：用户把自己的卡片编成组，工坊里整组拖进场景。
// cardIds 存的是 BranchCard.cardId（客户端稳定 id 字符串），不是 ObjectId——
// 卡片删除时由控制器 $pull 出所有卡组，保证不留悬空引用。
// ★ Mongoose 9 的 pre hook 不接收 next——本模型刻意不写任何 hook。
const mongoose = require("mongoose");

// 发布到工坊时对卡片内容做的快照。
// 卡片是按 { owner, cardId } 私有存的，别人装这套卡组时需要给他自己建一份；
// 快照让「装」这件事自包含 —— 发布者事后删卡或改卡，已发布的卡组也不会变成空壳。
const snapshotCardSchema = new mongoose.Schema(
  {
    cardId: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, default: "prop" },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 2000 },
    cover: { type: String, default: "" }, // 已是 Cloudinary URL（入库时转存过）
    tags: { type: [String], default: [] },
    hot: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const branchDeckSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    cardIds: { type: [String], default: [] },

    // ── 分享到创意工坊 ──
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: undefined },
    description: { type: String, default: "", trim: true, maxlength: 200 },
    /** 发布瞬间的卡片内容快照；未发布时为空数组 */
    cards: { type: [snapshotCardSchema], default: [] },
    /** 被别人装了多少次 */
    installs: { type: Number, default: 0, min: 0 },
    /** 装来的卡组记住来源，避免重复装同一套 + 以后好做「原作者」归属 */
    sourceDeck: { type: mongoose.Schema.Types.ObjectId, ref: "BranchDeck", default: undefined },
  },
  { timestamps: true, versionKey: false }
);

branchDeckSchema.index({ owner: 1, createdAt: -1 });
// 广场列表：只查已发布的，按发布时间倒序
branchDeckSchema.index({ published: 1, publishedAt: -1 });
// 同一个人对同一套源卡组只装一次
branchDeckSchema.index(
  { owner: 1, sourceDeck: 1 },
  { unique: true, partialFilterExpression: { sourceDeck: { $type: "objectId" } } }
);

module.exports = mongoose.model("BranchDeck", branchDeckSchema);
