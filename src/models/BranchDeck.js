// src/models/BranchDeck.js
// 分支视频 · 卡组：用户把自己的卡片编成组，工坊里整组拖进场景。
// cardIds 存的是 BranchCard.cardId（客户端稳定 id 字符串），不是 ObjectId——
// 卡片删除时由控制器 $pull 出所有卡组，保证不留悬空引用。
// ★ Mongoose 9 的 pre hook 不接收 next——本模型刻意不写任何 hook。
const mongoose = require("mongoose");
// 多图参考的子文档形状与 BranchCard 共用同一份（见那个文件的文件头）
const { cardViewSchema } = require("./cardView.schema");

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
    // ★ 与 BranchCard 一起补的两个字段。快照里漏声明的后果最隐蔽：
    //   卡片本身有建模和生成蓝图，装走之后变成没有——用户会以为是自己装错了。
    //   modelUrl 只可能是 http(s)（发布时 shareableModelUrl 已经剥过本地指针）。
    modelUrl: { type: String, default: "" },
    genPrompt: { type: String, default: "" },
    /** 固定身份句（与 BranchCard.idLine 同批，2026-08-28）。快照漏声明的后果同上：
     *  随卡组装走的卡出片时退回"名字+简介"，形象锚定变弱且看不出为什么 */
    idLine: { type: String, default: "", trim: true, maxlength: 200 },
    /** 真人声明。★ 快照里漏声明的后果：真人卡随卡组装走后变回"非真人"，出片档位
     *  分流静默失效——审核该严的没严，直到供应商拒单才暴露，而那时用户看到的只是
     *  "别人的卡组出片失败"，不会怀疑是装的时候掉了一个布尔 */
    realPerson: { type: Boolean, default: false },
    /** 多图参考。★ 快照里漏声明的后果和 modelUrl 那次一模一样、而且更难发现：
     *  装走的卡少了参考图，AI 照样能出片 —— 只是人物形象对不上，
     *  用户会以为是"这套卡本来就不太稳"，不会怀疑是少了几张图。 */
    views: { type: [cardViewSchema], default: [] },
  },
  { _id: false }
);

const branchDeckSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    cardIds: { type: [String], default: [] },
    /** 封面卡（客户端 cardId）。★ 客户端一直在发这个字段，但 schema/model 都没声明，
     *  于是被 z.object strip 掉 —— 表现是「设了封面，换台设备打开又变回第一张」。
     *  缺省/指向已被移出的卡时由客户端回退成组内第一张（deckCoverOf）。 */
    coverCardId: { type: String, default: "", trim: true, maxlength: 120 },

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
