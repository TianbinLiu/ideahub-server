const mongoose = require("mongoose");

const bookmarkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea" },
    leaderboard: { type: mongoose.Schema.Types.ObjectId, ref: "TagLeaderboard" },
    type: { type: String, enum: ["idea", "leaderboard"], required: true },
  },
  { timestamps: true }
);

bookmarkSchema.index({ user: 1, idea: 1 });
bookmarkSchema.index({ user: 1, leaderboard: 1 });

module.exports = mongoose.model("Bookmark", bookmarkSchema);
