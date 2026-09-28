// src/models/TutorRun.js
// 一个人在一位老师那里的学习过程（docs/05 §3.2：{user, course} 唯一；作者本人也有一条）。
// progress[stageId] = { status: pending|taught|passed, stepIdx, quiz, passedAt, reviewRound, nextReviewAt, lastReviewAt }
// —— **只有 core/session/progress.js 的 advance() 写它**（判据一处）；其余字段是会话的计数与蒸馏水位。
// 对应 tutor 仓课程工作区里的 .tutor/run.json。
const mongoose = require("mongoose");

const tutorRunSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["active", "done"], default: "active" },
    progress: { type: mongoose.Schema.Types.Mixed, default: {} },
    turnSeq: { type: Number, default: 0 },
    usage: { turns: { type: Number, default: 0 }, tokens: { type: Number, default: 0 }, distills: { type: Number, default: 0 } },
    // 蒸馏水位（docs/02 §4）：upTo = 上次蒸馏到第几轮；failedFrom = 上次在这个窗口整批被拒（不再自动重试，留给手动）
    distill: { upTo: { type: Number, default: 0 }, lastAt: { type: Date }, count: { type: Number, default: 0 }, failedFrom: { type: Number }, idleFor: { type: Date } }, // idleFor = 30 分钟那条已经处理过的 lastTurnAt（worker 不重复扫）
    lastTurnAt: { type: Date }, // 30 分钟没动作 = 下课 → worker 扫它触发蒸馏（tutor 仓那边是进程内计时器）
    startedAt: { type: Date, default: Date.now },
    doneAt: { type: Date },
    busy: { type: Boolean, default: false }, // 老师还在回上一句（同一 Run 同时只开一条流）
    distilling: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false },
);

tutorRunSchema.index({ course: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("TutorRun", tutorRunSchema);
