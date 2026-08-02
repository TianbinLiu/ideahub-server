// src/models/BranchVideo.js
// 分支视频（ideahub-app「卡片工坊」发布的作品）。
// segments 是线性播放序列；branchTree 存在时为互动分支树（扁平 nodes，允许 DAG 汇合）。
// cover / firstFrame / lastFrame / videoUrl 落库前已由 controller 转存到 Cloudinary，
// 转存失败的单个资源会降级保留原值（见 branchVideo.controller.js 的 transferDraftAssets）。
const mongoose = require("mongoose");

const segmentSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true, maxlength: 200 },
    plot: { type: String, default: "", trim: true, maxlength: 8000 },
    // 帧/视频地址：正常是 Cloudinary URL，转存失败时可能残留 dataURL，故不设 maxlength
    firstFrame: { type: String, default: "" },
    lastFrame: { type: String, default: "" },
    durationSec: { type: Number, default: 0, min: 0 },
    videoUrl: { type: String, default: "" },
  },
  { _id: false }
);

const choiceSchema = new mongoose.Schema(
  {
    label: { type: String, default: "", trim: true, maxlength: 200 },
    nextId: { type: String, default: "", trim: true, maxlength: 120 },
  },
  { _id: false }
);

const branchNodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 120 },
    segment: { type: segmentSchema, required: true },
    choices: { type: [choiceSchema], default: [] },
  },
  { _id: false }
);

const branchTreeSchema = new mongoose.Schema(
  {
    rootId: { type: String, default: "", trim: true, maxlength: 120 },
    startChoices: { type: [choiceSchema], default: undefined },
    // nodes 是 id -> BranchNode 的映射，键名由客户端生成，用 Map 存
    nodes: { type: Map, of: branchNodeSchema, default: undefined },
  },
  { _id: false }
);

const branchVideoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, default: "", trim: true, maxlength: 40 },
    description: { type: String, default: "", trim: true, maxlength: 4000 },
    cover: { type: String, default: "" },
    segments: { type: [segmentSchema], default: [] },
    branchTree: { type: branchTreeSchema, default: undefined },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    plays: { type: Number, default: 0, min: 0 },
    likes: { type: Number, default: 0, min: 0 },
    commentCount: { type: Number, default: 0, min: 0 },
    // 客户端幂等键：转存要几十秒，客户端超时重发时第一次可能已经落库了。
    // 认这个键去重，否则同一部作品会在库里存两份。老数据没有这个字段，故 sparse。
    clientId: { type: String, default: undefined, trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

// 幂等：同一作者同一 clientId 只允许一条（没带 clientId 的老数据不受约束）
branchVideoSchema.index(
  { author: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: "string" } } }
);

// 契约要求的三个索引
branchVideoSchema.index({ author: 1, createdAt: -1 });
branchVideoSchema.index({ category: 1, createdAt: -1 });
branchVideoSchema.index({ createdAt: -1 });

module.exports = mongoose.model("BranchVideo", branchVideoSchema);
