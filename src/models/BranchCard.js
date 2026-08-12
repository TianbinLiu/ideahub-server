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
// 多图参考的子文档形状与 BranchDeck 的快照共用同一份（见那个文件的文件头）
const { cardViewSchema } = require("./cardView.schema");

const branchCardSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    cardId: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: CARD_TYPES, default: "prop" },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 2000 },
    cover: { type: String, default: "" },
    // ⚠ hot 是**客户端发来的**种子热度，只做展示兜底，不再是「热度」的判据。
    //   真热度按 { kind:"card", key:cardId } 存在 BranchAssetStat 里，由服务端算。
    //   留着这个字段是为了兼容老客户端（它还在发），不接受它会整批加卡 400。
    hot: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    /** 3D 建模指针。可能是 `idb:model3d:*` 这种**只在卡主那台设备上有意义**的本地指针，
     *  所以发布/安装时会被剥掉（见 controller 的 shareableModelUrl） */
    modelUrl: { type: String, default: "" },
    /** 铸卡时的完整生成提示词（卡片详情页的「生成蓝图」） */
    genPrompt: { type: String, default: "" },
    /** 多图参考（最多 3 张，只可能是 http(s)）。喂给 Seedream 画方案首尾帧时锁形象。
     *  ★ 空数组与「字段不存在」在这里是**同一件事**（都表示"只有封面这一张形象"），
     *    所以 default 给 `[]` 而不是 undefined：客户端的归一（老卡 → 拿 cover 当唯一
     *    一张 body 图）只在 app 的 viewsOf() 一处做，服务端**不**替它补一份 ——
     *    补了就是同一条规则的第二处实现，两边一旦分叉，用户看到的参考图和真正喂给
     *    AI 的参考图会不是同一批，而这种偏差在结果里根本看不出来。 */
    views: { type: [cardViewSchema], default: [] },

    // ── 发布到创意工坊（与 BranchDeck 同一套语义）──
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: undefined },
    description: { type: String, default: "", trim: true, maxlength: 200 },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// 幂等的地基：同一用户同一 cardId 只能有一条
branchCardSchema.index({ owner: 1, cardId: 1 }, { unique: true });
// 「我的卡片」按时间倒序列出
branchCardSchema.index({ owner: 1, createdAt: -1 });
// 卡片广场：只查已发布的，按发布时间倒序（与 BranchDeck 的广场索引同形）
branchCardSchema.index({ published: 1, publishedAt: -1 });

module.exports = mongoose.model("BranchCard", branchCardSchema);
