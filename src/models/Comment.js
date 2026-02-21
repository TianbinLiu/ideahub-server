const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, required: true, trim: true, maxlength: 2000 },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

commentSchema.index({ idea: 1, createdAt: -1 });

module.exports = mongoose.model("Comment", commentSchema);
