// src/models/TutorTurn.js
// 学习会话里的一轮（docs/05 §3.2：单独成表 —— 一学期几百轮 × KB 级，内嵌会顶到 16MB）。{run, seq} 唯一。
// 形状与 tutor 仓 .tutor/turns.jsonl 里的一行相同：role / kind / text / stage_id / selection / flags / results / feedback / tokens / demo / replyTo / review / at。
// selection 缺失 = 普通一轮；review = 回访自检那一条。
const mongoose = require("mongoose");

const tutorTurnSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: "TutorRun", required: true, index: true },
    seq: { type: Number, required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    kind: { type: String, required: true }, // ask / answer / teach / quiz / quizResult / select / meta
    text: { type: String, default: "" },
    stage_id: { type: String, default: "" },
    selection: { type: mongoose.Schema.Types.Mixed },
    flags: { homeworkDetected: { type: Boolean }, policyBlocked: { type: Boolean } },
    results: { type: mongoose.Schema.Types.Mixed }, // quizResult：逐题 { q, expected, given, correct, why, anchor?, from? }
    review: { type: Boolean },
    replyTo: { type: Number },
    feedback: { type: Number, enum: [1, -1, null] },
    tokens: { type: Number, default: 0 },
    demo: { type: Boolean },
    at: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false, minimize: false },
);

tutorTurnSchema.index({ run: 1, seq: 1 }, { unique: true });

module.exports = mongoose.model("TutorTurn", tutorTurnSchema);
