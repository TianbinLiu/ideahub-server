// src/models/StandpointEvent.js
// 立场展开事件：一条别人发来的私信/回复，经分类 + 生成回复后登记。
const mongoose = require("mongoose");

const EVENT_KINDS = ["dm", "reply"];
const CLASSIFICATIONS = ["malicious", "question", "request", "other"];
const EVENT_STATUSES = ["pending", "drafted", "sent", "dismissed"];

const standpointReplySchema = new mongoose.Schema(
  {
    text: { type: String, default: "" },
    style: { type: String, default: "" },
    model: { type: String },
    heuristic: { type: Boolean },
  },
  { _id: false }
);

const standpointEventSchema = new mongoose.Schema(
  {
    agent: { type: mongoose.Schema.Types.ObjectId, ref: "StandpointAgent", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: EVENT_KINDS, required: true },
    platform: { type: String, default: "", trim: true, maxlength: 40 },
    fromHandle: { type: String, default: "", trim: true, maxlength: 80 },
    incomingText: { type: String, default: "", maxlength: 4000 },
    classification: { type: String, enum: CLASSIFICATIONS, default: "other" },
    reply: { type: standpointReplySchema, default: null },
    status: { type: String, enum: EVENT_STATUSES, default: "drafted", index: true },
    autoSent: { type: Boolean, default: false },
    threadUrl: { type: String, default: "", trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

standpointEventSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("StandpointEvent", standpointEventSchema);
module.exports.EVENT_KINDS = EVENT_KINDS;
module.exports.CLASSIFICATIONS = CLASSIFICATIONS;
module.exports.EVENT_STATUSES = EVENT_STATUSES;
