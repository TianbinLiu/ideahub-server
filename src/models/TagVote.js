const mongoose = require("mongoose");

const tagVoteSchema = new mongoose.Schema(
  {
    tags: { type: [String], default: [] },
    tagsKey: { type: String, required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    vote: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true }
);

// ensure one vote per user per idea per tag-combo
tagVoteSchema.index({ idea: 1, tagsKey: 1, user: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("TagVote", tagVoteSchema);
