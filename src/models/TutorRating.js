// src/models/TutorRating.js
// 老师人格的评分（tutor 仓 docs/05 §3 TutorRating；全仓第一张 1~5 星表，M2 后半 2026-09-29）。
// {user, persona} 唯一 = 一人一票、可改；Persona.stats.ratingAvg / ratingCount 由本表按星 aggregate **重算**回写（tutorRating.service.recompute），
// 不 $inc —— BranchAssetLike.js 头上的理由：重复、并发、改票三种情况 $inc 都会漂，而漂了的数字校不回来。
// 能不能评（前置：从这位老师开出的课至少一个阶段 passed 或整门 done；作者不能评自己；拉黑互不能评）只在核心包 core/publish/rating.canRate 一处。
const mongoose = require("mongoose");

const tutorRatingSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    persona: { type: mongoose.Schema.Types.ObjectId, ref: "Persona", required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse" }, // 评分时那门课（查「学到哪儿评的」用）
    stars: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: "", maxlength: 500 },
    atVersion: { type: Number, default: 0 }, // 评的是哪个发布版（学习者手里那门课当时钉的 sourceVersion）
  },
  { timestamps: true },
);

tutorRatingSchema.index({ user: 1, persona: 1 }, { unique: true });
tutorRatingSchema.index({ persona: 1, updatedAt: -1 });

module.exports = mongoose.model("TutorRating", tutorRatingSchema);
