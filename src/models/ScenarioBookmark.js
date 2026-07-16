const mongoose = require("mongoose");

const scenarioBookmarkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    scenario: { type: mongoose.Schema.Types.ObjectId, ref: "Scenario", required: true, index: true },
  },
  { timestamps: true }
);

scenarioBookmarkSchema.index({ user: 1, scenario: 1 }, { unique: true });

module.exports = mongoose.model("ScenarioBookmark", scenarioBookmarkSchema);
