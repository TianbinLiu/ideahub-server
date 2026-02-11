const mongoose = require("mongoose");

const likeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
  },
  { timestamps: true }
);

likeSchema.index({ user: 1, idea: 1 }, { unique: true });

module.exports = mongoose.model("Like", likeSchema);
