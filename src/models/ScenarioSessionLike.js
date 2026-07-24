// src/models/ScenarioSessionLike.js
// 对局点赞（对已分享的对局回放）。唯一索引防重复点赞，toggle 语义在 controller。
const mongoose = require("mongoose");

const scenarioSessionLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: "ScenarioSession", required: true },
  },
  { timestamps: true }
);

scenarioSessionLikeSchema.index({ user: 1, session: 1 }, { unique: true });
scenarioSessionLikeSchema.index({ session: 1 });

module.exports = mongoose.model("ScenarioSessionLike", scenarioSessionLikeSchema);
