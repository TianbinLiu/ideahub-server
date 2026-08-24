// src/models/BranchVideo.js
// 分支视频（ideahub-app「卡片工坊」发布的作品）。
// segments 是线性播放序列；branchTree 存在时为互动分支树（扁平 nodes，允许 DAG 汇合）。
// cover / firstFrame / lastFrame / videoUrl 落库前已由 controller 转存到 Cloudinary，
// 转存失败的单个资源会降级保留原值（见 branchVideo.controller.js 的 transferDraftAssets）。
const mongoose = require("mongoose");
// 卡片多图参考的子文档形状与 BranchCard / BranchDeck 快照共用同一份（见那个文件的文件头）
const { cardViewSchema } = require("./cardView.schema");

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
    /** 真人声明。与 views 同一个理由入快照（modelUrl/genPrompt 是"卡主私有"才不入）：
     *  观众收入卡组后要按它分流出片档位，漏声明 = mongoose 落库时静默剥掉，
     *  真人卡经作品这条路走一遭就变回"非真人"，零报错 */
    realPerson: { type: Boolean, default: false },
    /** 卡片的多图参考（http(s)，最多 3 张）。★ 与 modelUrl/genPrompt 那两个**刻意不入**
     *  快照的字段不同：views 是喂给 Seedream 锁形象的图，观众把这套卡组装走后要靠它
     *  炼出同一个人。漏声明的话 mongoose 落库时静默丢掉 —— 卡还在、参考图没了，
     *  用户只会觉得"这套卡本来就不太稳"，没人查得到这里（同 deck 当年那次）。 */
    views: { type: [cardViewSchema], default: [] },
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

// 付费设置。partPrices 与分集对齐；单 P 作品长度为 1。
// ★ 不给 default：没有这个字段 = 免费，和"明确设成免费"在语义上没有区别，
//   但给了 default 会让每条老作品都凭空多出一个 pricing 对象。
const pricingSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["free", "paid"], default: "free" },
    partPrices: { type: [Number], default: [] },
  },
  { _id: false }
);

// 平台下架（管理员操作）。
//
// ★★ **不复用 visibility**：那是**作者自己的开关**，作者随时能 PATCH 回 public
//   （updateVideo 只校验"是不是作者"）。下架必须是作者**改不动**的，
//   所以它是另一个字段，而且全仓只有 admin 那两条端点写得动它。
//   （updateBody 那份 zod 是 z.object，未声明字段一律 strip —— 作者就算在 PATCH 里
//    塞一个 takedown 也到不了 controller。这次是 strip 帮了忙，但它是**第二道**，
//    第一道是"这个字段压根不在 updateBody 里"。tests/branchAdmin.spec.js 钉住了。）
//
// ★ 状态用「这个子文档在不在」表示，不另加一个 takenDown 布尔：
//   布尔 + 三个平行字段会长出"布尔是 true 但没有原因"的半状态，
//   而查询条件也就得跟着判两处。撤销下架一律 `$unset` 把整个子文档删掉 ——
//   写成 `takedown: null` 的话 `$exists` 仍然为真，作品会永远出不来，且一个错都不报。
//   （正因如此，controller 里的库内判据用的是 **`takedown.at`** 这条路径而不是
//    `takedown` 本身：null 的 `takedown.at` 判为"没下架"，坏数据的失败方向是
//    "作品还在"而不是"作品永远消失"。）
//
// ★ 三样都要记，各有各的用处：
//   by     —— 事后追责/申诉时找得到人（**不回给作者**，见 controller 的 toVideoPayload）
//   at     —— 申诉时效、后台按时间倒序列出
//   reason —— **作者会看到这句话**。凭空消失比下架更糟：用户只会以为系统吞了他的作品，
//             然后原样再发一遍。所以端点上 reason 是必填的。
const takedownSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, required: true },
    // 给人读的一句话，不是自由文本存储，所以给上限
    reason: { type: String, default: "", trim: true, maxlength: 500 },
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
    pricing: { type: pricingSchema, default: undefined },
    // 可见性。★ 查询一律用 { visibility: { $ne: "private" } } 而不是 { visibility: "public" }：
    // 这个字段是后加的，**存量作品没有它**，按等值查会把所有老作品从首页上抹掉。
    visibility: { type: String, enum: ["public", "private"], default: "public" },
    // 平台下架。★ 不给 default：绝大多数作品**没有**这个字段，给 default 会让
    // 每一条老作品都凭空多出一个空的下架记录（同 pricing / aspect 那两处的理由）。
    takedown: { type: takedownSchema, default: undefined },
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
// 后台「下架列表」用。★ partial 索引：全站绝大多数作品没有这个字段，
// 建全量索引等于给一张几乎全空的列建一棵树。条件与 controller 的 TAKEN_DOWN
// **逐字相同**（`takedown.at` 是 date）——不同的话这条索引就永远用不上，
// 而且不会有任何报错，只是查询慢慢地变成全表扫。
branchVideoSchema.index(
  { "takedown.at": -1 },
  { partialFilterExpression: { "takedown.at": { $type: "date" } } }
);

module.exports = mongoose.model("BranchVideo", branchVideoSchema);
