const mongoose = require("mongoose");

const scenarioLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    scenario: { type: mongoose.Schema.Types.ObjectId, ref: "Scenario", required: true, index: true },
  },
  { timestamps: true }
);

scenarioLikeSchema.index({ user: 1, scenario: 1 }, { unique: true });

module.exports = mongoose.model("ScenarioLike", scenarioLikeSchema);
