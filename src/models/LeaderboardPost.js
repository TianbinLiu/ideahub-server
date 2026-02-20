const mongoose = require("mongoose");

const LeaderboardPostSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  tagsKey: { type: String, required: true, index: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  likesCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("LeaderboardPost", LeaderboardPostSchema);
