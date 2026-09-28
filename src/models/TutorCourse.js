// src/models/TutorCourse.js
// 老师人格（tutor）的「课程」：作者建的一门课 —— 标题 / 学科 / AI 政策 / 关键日期。**永不发布**（docs/05 §3.2）；
// policy 是 TutorDoc.policy 的源头，生成时拷进文档并锁成 🔒 硬规则（core/generate/demo.js hardRulesFrom）。
// 对应 tutor 仓课程工作区里的 course.json（docs/04 §5 S24）。判否定：policy.ai 缺失当 "limited"（往严的方向）。
const mongoose = require("mongoose");

const keyDateSchema = new mongoose.Schema(
  { label: { type: String, required: true, maxlength: 60 }, at: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, kind: { type: String, enum: ["exam", "homework", "project", "other"], default: "other" } },
  { _id: false },
);

const tutorCourseSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    subject: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, trim: true, maxlength: 60 },
    term: { type: String, trim: true, maxlength: 40 },
    policy: {
      ai: { type: String, enum: ["prohibited", "limited", "allowed"], default: "limited" },
      homework_mode: { type: String, enum: ["principles_only", "full"], default: "principles_only" },
      allowed_uses: { type: [String], default: [] },
      text: { type: String, default: "", maxlength: 2000 },
    },
    key_dates: { type: [keyDateSchema], default: [] },
    // 从别人的导出件「导入一位老师」开出来的课（docs/02 5.5）：course 信息派生自 frontmatter，没有教材
    importedFromPersona: { type: Boolean, default: false },
    // 从市场「开始跟这位老师学」开出来的课（docs/02 5.7）：指向那位老师与当时的发布版；同一人对同一位老师只开一门（幂等，靠 {owner, sourcePersona} 查）
    sourcePersona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", index: true },
    sourceRelease: { type: mongoose.Schema.Types.ObjectId, ref: "TutorRelease" },
    sourceVersion: { type: Number },
  },
  { timestamps: true },
);

tutorCourseSchema.index({ owner: 1, updatedAt: -1 });
tutorCourseSchema.index({ owner: 1, sourcePersona: 1 });

module.exports = mongoose.model("TutorCourse", tutorCourseSchema);
