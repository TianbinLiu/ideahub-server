const mongoose = require("mongoose");

const EntrySchema = new mongoose.Schema({
  idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
  score: { type: Number, default: 0 },
  votes: { type: Number, default: 0 },
});

const TagLeaderboardSchema = new mongoose.Schema({
  tagsKey: { type: String, required: true, unique: true },
  tags: [{ type: String }],
  entries: [EntrySchema],
  computedAt: { type: Date, default: Date.now },
});

TagLeaderboardSchema.index({ tagsKey: 1 }, { unique: true });

module.exports = mongoose.model("TagLeaderboard", TagLeaderboardSchema);
