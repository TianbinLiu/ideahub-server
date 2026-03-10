const mongoose = require("mongoose");

const scraperJobSchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, trim: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["running", "success", "failed"], default: "running", index: true },
    params: {
      keywords: { type: [String], default: [] },
      minViews: { type: Number, default: 0 },
      limit: { type: Number, default: 20 },
      maxPages: { type: Number, default: 5 },
      maxCreate: { type: Number, default: 20 },
      _id: false,
    },
    stats: {
      scanned: { type: Number, default: 0 },
      createdCount: { type: Number, default: 0 },
      skippedBelowThreshold: { type: Number, default: 0 },
      skippedExisting: { type: Number, default: 0 },
      skippedInvalid: { type: Number, default: 0 },
      skippedOverCreateLimit: { type: Number, default: 0 },
      _id: false,
    },
    createdIdeas: [{ type: mongoose.Schema.Types.ObjectId, ref: "Idea" }],
    createdPreview: {
      type: [
        {
          title: String,
          url: String,
          views: Number,
          tags: [String],
          _id: false,
        },
      ],
      default: [],
    },
    errorMessage: { type: String, default: "" },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);

scraperJobSchema.index({ createdAt: -1 });

module.exports = mongoose.model("ScraperJob", scraperJobSchema);
