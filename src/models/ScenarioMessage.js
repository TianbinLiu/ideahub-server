const mongoose = require("mongoose");

// 数据收集：记录真实用户在情景模拟里发表的每一条发言
const scenarioMessageSchema = new mongoose.Schema(
  {
    scenario: { type: mongoose.Schema.Types.ObjectId, ref: "Scenario", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, default: "", trim: true, maxlength: 4000 },
    parentId: { type: String, default: null },
    platform: { type: String, default: "generic" },
  },
  { timestamps: true }
);

scenarioMessageSchema.index({ scenario: 1, createdAt: -1 });

module.exports = mongoose.model("ScenarioMessage", scenarioMessageSchema);
