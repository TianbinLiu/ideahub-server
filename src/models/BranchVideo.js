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
    /** Seedance 档位 id（app 的 data/economy VIDEO_TIERS）。缺省=标准档 */
    videoTier: { type: String, default: undefined, trim: true, maxlength: 80 },
    /** 画幅。★ 不给 default："没有这个字段"和"明确是横屏"要分得开——
     *  app 侧 aspectOf() 把缺省当横屏（老作品全是 16:9 写死的），给了 default
     *  等于替老数据做了一个它没做过的声明 */
    aspect: { type: String, enum: ["portrait", "landscape"], default: undefined },
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

// 随作品发布的卡组：**内嵌快照**，不是对 BranchCard 的引用。
// 作者事后删掉自己库里的卡，已发布作品里的卡组也不能跟着少几张——观众看到的
// 必须是发布那一刻的样子。字段与 BranchCard 对齐（cardId 同为客户端稳定 id）。
const deckCardSchema = new mongoose.Schema(
  {
    cardId: { type: String, default: "", trim: true, maxlength: 120 },
    type: { type: String, default: "prop", trim: true, maxlength: 40 },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 2000 },
    // 转存失败时可能残留 dataURL，同 segment 的帧字段，不设 maxlength
    cover: { type: String, default: "" },
    tags: { type: [String], default: [] },
  },
  { _id: false }
);

const deckSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true, maxlength: 120 },
    cards: { type: [deckCardSchema], default: [] },
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
    deck: { type: deckSchema, default: undefined },
    // 可见性。★ 查询一律用 { visibility: { $ne: "private" } } 而不是 { visibility: "public" }：
    // 这个字段是后加的，**存量作品没有它**，按等值查会把所有老作品从首页上抹掉。
    visibility: { type: String, enum: ["public", "private"], default: "public" },
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
// 公开流现在每条查询都带 visibility 条件，给它一条能整条走索引的复合索引
branchVideoSchema.index({ visibility: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("BranchVideo", branchVideoSchema);
