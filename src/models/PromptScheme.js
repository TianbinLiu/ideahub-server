// src/models/PromptScheme.js
// 「提示词方案」：人物卡设定图的出图配方（若干图位模板）。
//
// ★ 与 BranchCard 同构：`schemeId` 是**客户端生成的稳定 id**，同一套方案被 N 个人装走
//   之后库里是 N 份文档（各自属于装的人），靠 schemeId 认它是"同一套"。
//   这样"改自己那份"永远只动自己那一行，不会影响别人已经装走的。
const mongoose = require("mongoose");
const { CARD_VIEW_ROLES, CARD_VIEW_TAG_MAX } = require("../schemas/branchAsset.schemas");
const { SLOT_PROMPT_MAX } = require("../schemas/promptScheme.schemas");

// _id:false —— 纯数据子文档，给每个图位发一个 ObjectId 只会让回包变大
const slotSchema = new mongoose.Schema(
  {
    /** 界面花名，会进 CardView.tag */
    tag: { type: String, required: true, trim: true, maxlength: CARD_VIEW_TAG_MAX },
    /** 出片管线里干什么，会进 CardView.role。★ 枚举复用卡片那份（唯一事实源） */
    role: { type: String, enum: CARD_VIEW_ROLES, required: true },
    /** 这一格的提示词正文。画风那句由客户端 slotPrompt 统一拼，不存在这里 */
    prompt: { type: String, default: "", trim: true, maxlength: SLOT_PROMPT_MAX },
    /**
     * 拿哪张裁剪当参考（body=主裁剪 / face=脸部裁剪）。
     * ★ 缺省不写：缺省的语义是"用主裁剪"（客户端 `slot.ref ?? "body"` 一处实现），
     *   在这里补 default 就是第二处默认值。
     */
    ref: { type: String, enum: ["body", "face"] },
    /** 出图尺寸；缺省 = 卡面画布（客户端 slotSize 一处实现） */
    size: { type: String, trim: true, maxlength: 20 },
    /** 直接放原片裁剪、不调模型 —— **这一格不计费**（客户端 isGenerated / schemeCost 同源） */
    fromCrop: { type: Boolean },
  },
  { _id: false }
);

const promptSchemeSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    authorName: { type: String, default: "", trim: true, maxlength: 60 },
    /** 客户端稳定 id（ps_xxx）。与 ownerId 组成唯一键：一个人同一套只留一份 */
    schemeId: { type: String, required: true, trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 40 },
    intro: { type: String, default: "", trim: true, maxlength: 120 },
    /**
     * 产出里不含可辨认人脸。**只描述产出形态**，不是"绕过检测的成功率"——
     * 市场按它把无脸方案排前面（产品决定），但**不得**按绕过率排序或标注。
     */
    faceless: { type: Boolean, default: false },
    slots: { type: [slotSchema], default: [] },
    /** 预览缩图（dataURL，约 1KB/张）。长度硬门在 zod 那层 */
    examples: { type: [String], default: [] },
    published: { type: Boolean, default: false, index: true },
    /**
     * 第一次发布到广场的时刻。**排"谁是权威那份"用的就是它**（与 BranchCard.publishedAt
     * 同一个作用，2026-08-31 补）。
     * ★★ 没有这一位的后果：广场按 `updatedAt` 排，去重留下的是**最后编辑**的那份 ——
     *   B 装走 A 的方案再发布一次，广场上那一行当场换成 B 的文档，A 的方案从广场消失，
     *   A 的「已分享」按钮仍是成功态、收不到任何提示。两边都是 200、零报错。
     * ★ 缺省（存量）= 没有这一位，排序时排在最后 —— 与"它确实是老数据"无法区分，
     *   所以下面 AUTH_SORT 用 `_id` 兜底（ObjectId 单调递增，就是创建顺序）。
     */
    publishedAt: { type: Date },
    /**
     * 「这份是从谁那儿装来的」。有值 = **装来的副本，永远不许再分享一遍**
     * （与 BranchCard.sourceOwner 同一个作用，2026-08-31 补）。
     * ★ 判**有值**而不是判否定：老数据没有这一位 = 当作原创，不能把存量整批判成转发。
     */
    sourceOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  },
  { timestamps: true }
);

// 同一个人的同一套方案只留一份（upsert 的键）
promptSchemeSchema.index({ ownerId: 1, schemeId: 1 }, { unique: true });
// 广场按发布时间倒序翻
promptSchemeSchema.index({ published: 1, updatedAt: -1 });
// 广场去重与 install 共用的权威排序（见 controller 的 AUTH_SORT）
promptSchemeSchema.index({ published: 1, publishedAt: 1, _id: 1 });

module.exports = mongoose.models.PromptScheme || mongoose.model("PromptScheme", promptSchemeSchema);
