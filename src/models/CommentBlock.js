const mongoose = require("mongoose");

const commentBlockSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
    blockedUntil: { type: Date, required: true },
    reason: { type: String, default: "rate_limit" },
  },
  { timestamps: true }
);

commentBlockSchema.index({ user: 1, idea: 1 }, { unique: true });
commentBlockSchema.index({ blockedUntil: 1 });

module.exports = mongoose.model("CommentBlock", commentBlockSchema);
