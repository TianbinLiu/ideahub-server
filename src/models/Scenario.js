const mongoose = require("mongoose");

const SCENARIO_PLATFORMS = ["bilibili", "weibo", "tieba", "zhihu", "instagram", "generic"];

const scenarioCommentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    authorName: { type: String, required: true, trim: true, maxlength: 80 },
    authorAvatar: { type: String, default: "" },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    likeCount: { type: Number, default: 0 },
    parentId: { type: String, default: null },
    isOP: { type: Boolean, default: false },
    stance: { type: String, default: "", trim: true, maxlength: 200 },
  },
  { _id: false }
);

const scenarioSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 500 },
    coverImageUrl: { type: String, default: "" },
    platform: { type: String, enum: SCENARIO_PLATFORMS, default: "generic", index: true },
    tags: { type: [String], default: [] },
    shared: { type: Boolean, default: false, index: true },
    sourceUrl: { type: String, default: "" },
    topic: { type: String, default: "", trim: true, maxlength: 2000 },
    comments: { type: [scenarioCommentSchema], default: [] },
    stats: {
      viewCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      bookmarkCount: { type: Number, default: 0 },
      playCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

scenarioSchema.index({ shared: 1, createdAt: -1 });
scenarioSchema.index({ shared: 1, "stats.likeCount": -1 });

module.exports = mongoose.model("Scenario", scenarioSchema);
module.exports.SCENARIO_PLATFORMS = SCENARIO_PLATFORMS;
