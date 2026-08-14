// src/models/BranchTemplate.js
// 白模模板（blockout r2v）：作者上传一段「红色小人 + 场景/道具/运镜」的白模视频，
// 别人套用它出片时走方舟 r2v（参考视频生视频），把小人换成自己的角色、保留全片调度。
//
// ★ 别与 models/WorkshopTemplate.js 混淆 —— 那是另一条产品线（官网创意工坊）的
//   页面布局模板，两者除了名字里都有 Template 之外没有任何关系。
//
// ★★ refVideo 里的 durationSec/width/height/bytes **只由服务端从 Cloudinary 的
//   回执/资源详情写入**（见 routes/branchTemplate.routes.js 的建模板一步），
//   客户端发什么都不作数（zod schema 里根本没有这些字段，发了也会被 strip）。
//   为什么这么较真：durationSec 是 r2v 结算的输入时长（方舟公式里输入视频时长
//   计进 token），信客户端报的数等于让用户自己给自己标价（config/tokens.js 顶部原则）。
const mongoose = require("mongoose");

// 参考视频（白模本体）。整个子文档在建模板时一次性写入，之后不可改 ——
// 「换视频」= 删掉重建（r2v 结算按 url 反查这份登记，可改的话登记就不再可信）。
const refVideoSchema = new mongoose.Schema(
  {
    /** Cloudinary 的 secure_url（**服务端**从资源详情取的规范形态，不是客户端传的原串）。
     *  规范化的意义：同一个 public_id 永远对应同一个 url 字符串，下面的 unique 索引
     *  才真能挡住「同一段视频挂两个模板」——客户端只要往 URL 里塞一段无害的
     *  transformation 就能绕开按原串去重。 */
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    /** r2v 结算的输入时长（秒，整数）。上传窗口 [4,15]（middleware/upload.js 的
     *  templateVideoIssue 是这条窗口的唯一实现），min/max 只是模型层的最后兜底 */
    durationSec: { type: Number, required: true, min: 1, max: 60 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    bytes: { type: Number, required: true, min: 0 },
    /** 删模板时 uploader.destroy 回收云端资产用（不回收 = 上传即永久占配额） */
    cloudinaryPublicId: { type: String, required: true, trim: true, maxlength: 300 },
  },
  { _id: false }
);

// 经典配方部分。★ 刻意写成**独立成立**：老客户端认不出 refVideo 时，把这份 recipe
// 当经典配方模板跑也能出一段"降级但诚实"的片（beat/styleHint/framePrompt 都是
// 提取时视觉调用照写的真内容，不是占位符）。r2v 的「替换红色小人」语义句**不进**
// recipe —— 那句话由 app 的 segmentGen 出片时统一拼（一句话一处实现）。
const recipeSchema = new mongoose.Schema(
  {
    styleHint: { type: String, default: "", trim: true, maxlength: 2000 },
    beats: { type: [String], default: [] },
    /** 经典降级路的段时长。白模路的真实时长以 refVideo.durationSec 为准（edit 输出≈输入），
     *  这里只是给老客户端的镜像值 */
    durationSec: { type: Number, default: 5, min: 1, max: 60 },
    /** app 档位 id（"fast"|"std"|"hd"|"ultra"）。不写 enum：这是 app 侧报价用的展示数据，
     *  服务端不据此做任何判断，写 enum 只会让 app 加档位时老服务端凭空 400 */
    videoTier: { type: String, default: "", trim: true, maxlength: 40 },
    /** 画幅。与 BranchVideo.segment.aspect 同一对取值。不给 default：
     *  「没声明」和「明确横屏」要分得开（同 BranchVideo 那条注释的理由） */
    aspect: { type: String, enum: ["portrait", "landscape"], default: undefined },
    framePrompt: { type: String, default: "", trim: true, maxlength: 4000 },
  },
  { _id: false }
);

const branchTemplateSchema = new mongoose.Schema(
  {
    /** 身份判定的唯一依据。★ 绝不拿 authorName 判「这是不是我的」——
     *  显示名会改（CLAUDE.md「拿名字当身份」坑），authorName 只是列表页的显示快照 */
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    authorName: { type: String, default: "", trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    intro: { type: String, default: "", trim: true, maxlength: 2000 },
    /** 市场卡片封面。https URL（发布链路里由 /api/uploads/image 转存），不收 dataURL——
     *  dataURL 会让 shared 列表一次回包几十 MB（与 BranchDeck.cover 同一条教训） */
    coverUrl: { type: String, default: "", trim: true, maxlength: 2000 },
    recipe: { type: recipeSchema, required: true },
    refVideo: { type: refVideoSchema, required: true },
    /**
     * pending  —— 刚建好/已下架回炉，只有作者自己可见可用
     * published —— 上市场，人人可套
     * blocked  —— 平台下架（事后治理），只有管理员写得动，作者 publish/unpublish 都动不了
     * ★ 新集合、字段必填带默认，**不存在**「存量数据缺字段」的问题，
     *   所以公开列表用等值 { status: "published" } 是安全的；「否定式判存量字段」
     *   那条仓规针对的是往老数据上后加字段的场景，别在这里误用成理由。
     */
    status: { type: String, enum: ["pending", "published", "blocked"], default: "pending" },
    /**
     * 试炼闸：作者本人用这个模板真实出过一次片的时刻。null = 还没证明过。
     * ★ 只由服务端的 r2v 任务追踪写入（ark.routes.js 轮询到 succeeded 且任务发起人
     *   就是模板作者时），不信客户端一句「我跑通了」。发布（publish）以它非空为前置：
     *   方舟受理后才失败不退费，坏模板的那次学费必须由作者自己付，不能摊给每个套用的人。
     */
    provenAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// r2v 结算按参考视频 URL 反查登记（ark.routes.js 的 resolveR2v），一条 URL 只许一个模板。
// url 是服务端规范化过的 secure_url（见上），所以这条唯一索引挡得住变体绕过。
branchTemplateSchema.index({ "refVideo.url": 1 }, { unique: true });
// 「我的模板」按新旧排
branchTemplateSchema.index({ ownerId: 1, createdAt: -1 });
// 市场列表：只查 published，按新旧排
branchTemplateSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("BranchTemplate", branchTemplateSchema);
