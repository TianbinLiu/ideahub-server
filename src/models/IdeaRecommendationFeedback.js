const mongoose = require("mongoose");

const ideaRecommendationFeedbackSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true, index: true },
    reason: {
      type: String,
      enum: ["not_interested", "already_recommended"],
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

ideaRecommendationFeedbackSchema.index({ user: 1, idea: 1 }, { unique: true });

module.exports = mongoose.model("IdeaRecommendationFeedback", ideaRecommendationFeedbackSchema);