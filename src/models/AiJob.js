const mongoose = require("mongoose");

const AiJobSchema = new mongoose.Schema(
  {
    ideaId: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true, index: true },
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    status: { type: String, enum: ["pending", "running", "succeeded", "failed"], default: "pending", index: true },

    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },

    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);

// 同一个 idea 同时只能有一个未完成任务（pending/running）
AiJobSchema.index(
  { ideaId: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ["pending", "running"] } } }
);

module.exports = mongoose.model("AiJob", AiJobSchema);
