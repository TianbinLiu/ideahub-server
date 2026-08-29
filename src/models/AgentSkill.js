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
  },
  { timestamps: true }
);

agentSkillSchema.index({ ownerId: 1, skillId: 1 }, { unique: true });
agentSkillSchema.index({ published: 1, updatedAt: -1 });

module.exports = mongoose.models.AgentSkill || mongoose.model("AgentSkill", agentSkillSchema);
