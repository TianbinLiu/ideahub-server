const mongoose = require("mongoose");

const ideaViewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true, index: true },
    lastViewedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// 每个用户对每个 idea 只有一条记录
ideaViewSchema.index({ user: 1, idea: 1 }, { unique: true });

module.exports = mongoose.model("IdeaView", ideaViewSchema);
