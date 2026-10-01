// src/models/TutorDoc.js
// 一门课的头文档 = 自用件 persona.md 在库里的样子（docs/03；tutor 仓课程工作区里的 persona.md）。
// **一门课一条、可变**：② 画像的自动 op、③ 状态列随进度回写、授权来源重算都改它，只有作者点头 / 扫描点头才 version+1
// （docs/02 4.5）。docs/05 §3.2 把 TutorDoc 画成「每版一条、不可变」，参考实现落地时改成了「头文档 + 修订记录（TutorRevision，append-only）」：
// 历史在修订记录里、导出留痕在 TutorExport 里，够反查；每版快照留到 M2 市场发布时再加（发布件本来就是另一份裁剪过的文档）。
// text 是渲染好的 Markdown（首尾显式标识 + frontmatter AIGC 隐式标识），doc 是解析后的 JSON；两者由 core/format 的 render / parse 保证互为镜像。
const mongoose = require("mongoose");

const tutorDocSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, unique: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    personaId: { type: String, required: true, index: true }, // frontmatter 的 id（24 hex，与导出件 / 修订记录里的 runId 同一个）
    version: { type: Number, required: true, default: 1 },
    name: { type: String, required: true },
    text: { type: String, required: true }, // 渲染后的 .md 全文（几十 KB）
    doc: { type: mongoose.Schema.Types.Mixed, required: true }, // parseTutorDoc(text).doc
    checksum: { type: String, default: "" },
    produceId: { type: String, default: "" }, // AIGC.ProduceID（uuid v5 of tutor:<id>:v<version>）
    // 生成检查点（core/generate/pipeline 的 ck：断了接着跑、不重扣已完成块）—— 落在 TutorJob 上；这里只留最近一次生成的方法与调用数
    provenance: { method: { type: String, default: "" }, calls: { type: Number, default: 0 }, mode: { type: String, default: "" } },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TutorDoc", tutorDocSchema);
