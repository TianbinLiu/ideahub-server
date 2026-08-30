// src/models/AgentSkill.js
// 「出片技能」：把一句（或几句）画布 agent 指令存成可复用、可发布的实体
// （app 仓 backlog 2.8-⑤ 的发布半，2026-08-29 主人拍板进方案市场家族）。
//
// ★ 与 PromptScheme 同构（那套已经把本仓踩过的坑都固化了）：`skillId` 是客户端稳定 id
//   （ask_xxx），同一技能被 N 个人装走 = N 份文档各自归属；(ownerId, skillId) 唯一。
// ★ 技能的本体只有一段 `text`（要发给画布 agent 的那句话）——卡组/参数都由句子本身
//   承载（「第2段套模板「宗主」；给第1段挂卡：红色=凛」），不另建结构化字段：
//   agent 的白名单闸在执行侧（canvasAgent），技能只是把"说过的话"存起来。
const mongoose = require("mongoose");
const { SKILL_TEXT_MAX } = require("../schemas/agentSkill.schemas");

const agentSkillSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    authorName: { type: String, default: "", trim: true, maxlength: 60 },
    /** 客户端稳定 id（ask_xxx）。与 ownerId 组成唯一键：一个人同一技能只留一份 */
    skillId: { type: String, required: true, trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 20 },
    intro: { type: String, default: "", trim: true, maxlength: 120 },
    /** 技能本体：发给画布 agent 的那句话（可含分号分隔的多条指令） */
    text: { type: String, required: true, trim: true, maxlength: SKILL_TEXT_MAX },
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

agentSkillSchema.index({ ownerId: 1, skillId: 1 }, { unique: true });
agentSkillSchema.index({ published: 1, updatedAt: -1 });
// 广场去重与 install 共用的权威排序（见 controller 的 AUTH_SORT）
agentSkillSchema.index({ published: 1, publishedAt: 1, _id: 1 });

module.exports = mongoose.models.AgentSkill || mongoose.model("AgentSkill", agentSkillSchema);
