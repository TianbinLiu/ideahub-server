// src/models/TutorRelease.js
// 老师人格的**发布版**快照（docs/02 6.2；docs/05 §3.2 里「TutorDoc 每版一条、不可变」的那一半）。
// 头文档 TutorDoc 是可变的自用件；发布那一拍按 audience=market 裁剪（② 只带种子、学生问答不带、③ 状态列清空）→ 泄漏核查 → 渲染 → 落一条这里，**从不改**。
// Persona.currentDoc 指向最新一条；「开始跟这位老师学」从它复制（教材不复制，docs/02 5.7）；「合并新版」按 {persona, version} 找旧版比对。
// ★ 与导出发布件同一份实现（core/export.buildExport）：导出能发出去的，市场也能发；导出被泄漏核查拒的，市场同样拒。
const mongoose = require("mongoose");

const tutorReleaseSchema = new mongoose.Schema(
  {
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, required: true },
    personaId: { type: String, required: true }, // frontmatter 的 id（与 TutorDoc.personaId 同一个）
    name: { type: String, required: true },
    doc: { type: mongoose.Schema.Types.Mixed, required: true }, // 裁剪过的发布件（audience=market）
    text: { type: String, required: true }, // 渲染后的 .md（首尾显式标识 + frontmatter AIGC）
    checksum: { type: String, default: "" },
    sha256: { type: String, default: "" }, // text 的 sha256（详情页显示、导入回读比对）
    produceId: { type: String, default: "" },
    stages: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 200 }, // 作者写的版本说明
    publishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

tutorReleaseSchema.index({ persona: 1, version: 1 }, { unique: true });

module.exports = mongoose.model("TutorRelease", tutorReleaseSchema);
