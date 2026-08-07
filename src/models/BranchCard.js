// src/models/BranchCard.js
// 分支视频 · 用户卡片（人物/场景/背景/道具/风格）。
// cardId 是客户端生成的稳定 id（工坊炼卡 `card_*`、市场卡 `mkt_*`），
// 服务端不重新发号，靠 { owner, cardId } 唯一索引做批量新增的幂等。
// cover 入库前已由控制器把 dataURL 转存成 Cloudinary 永久 URL（转存失败降级保留原值，
// 所以这里不给 cover 设 maxlength，避免 dataURL 兜底时被 mongoose 校验拦下）。
// ★ Mongoose 9 的 pre hook 不接收 next——本模型刻意不写任何 hook。
const mongoose = require("mongoose");
// 类型枚举只在 schemas/branchAsset.schemas.js 定义一份，避免改一处漏一处（表现是整批加卡 400）
const { CARD_TYPES } = require("../schemas/branchAsset.schemas");

const branchCardSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    cardId: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: CARD_TYPES, default: "prop" },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 2000 },
    cover: { type: String, default: "" },
    hot: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// 幂等的地基：同一用户同一 cardId 只能有一条
branchCardSchema.index({ owner: 1, cardId: 1 }, { unique: true });
// 「我的卡片」按时间倒序列出
branchCardSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("BranchCard", branchCardSchema);
