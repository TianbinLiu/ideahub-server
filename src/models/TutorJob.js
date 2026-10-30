// src/models/TutorJob.js
// 长活（docs/05 §4.8）：生成人格是几分钟的多轮模型调用，端点只受理 + 回 jobId，worker 在 0 号实例串行跑（core/generate/pipeline runGenerate）。
// 抢占照 AiJob（findOneAndUpdate pending → running，attempts+1）；checkpoint 是 pipeline 的 ck（阶段提议 / 逐阶段蒸馏 / ① ⑥ 各一格），
// 断了接着跑、不重扣已完成块。同一门课同时只有一个未完成的生成（partial unique）。
const mongoose = require("mongoose");

const tutorJobSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: ["generate"], default: "generate" },
    status: { type: String, enum: ["pending", "running", "succeeded", "failed"], default: "pending", index: true },
    attempts: { type: Number, default: 0 },
    questionnaire: { type: mongoose.Schema.Types.Mixed, default: {} },
    progress: { type: mongoose.Schema.Types.Mixed, default: { step: "queued", done: 0, total: 1, message: "排队中" } },
    checkpoint: { type: mongoose.Schema.Types.Mixed },
    result: { type: mongoose.Schema.Types.Mixed },
    failures: { type: [String], default: [] },
    error: { type: String },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true, minimize: false },
);

tutorJobSchema.index({ course: 1, status: 1 }, { partialFilterExpression: { status: { $in: ["pending", "running"] } } });
tutorJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("TutorJob", tutorJobSchema);
