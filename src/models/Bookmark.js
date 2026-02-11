const mongoose = require("mongoose");

const bookmarkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
  },
  { timestamps: true }
);

bookmarkSchema.index({ user: 1, idea: 1 }, { unique: true });

module.exports = mongoose.model("Bookmark", bookmarkSchema);
