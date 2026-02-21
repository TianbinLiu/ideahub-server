const mongoose = require("mongoose");

// const aiReviewSchema = new mongoose.Schema(
//   {
//     feasibilityScore: { type: Number, min: 0, max: 10 },
//     profitPotentialScore: { type: Number, min: 0, max: 10 },
//     analysisText: { type: String, default: "" },
//   },
//   { _id: false }
// );

const statsSchema = new mongoose.Schema(
  {
    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    bookmarkCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const ideaSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 300 },
    content: { type: String, default: "" },

    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    tags: { type: [String], default: [] },

    visibility: { type: String, enum: ["public", "private", "unlisted"], default: "public" },

    invitedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],

    isMonetizable: { type: Boolean, default: false },
    licenseType: { type: String, default: "default" },

    aiReview: {
      feasibilityScore: { type: Number, min: 0, max: 100 },
      profitPotentialScore: { type: Number, min: 0, max: 100 },
      analysisText: { type: String, default: "" },
      model: { type: String, default: "" },
      createdAt: { type: Date },
    },

    stats: { type: statsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Idea", ideaSchema);
