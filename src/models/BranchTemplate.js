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
    /** r2v 结算的输入时长（秒，整数）。参考视频窗口 [4,30]（middleware/upload.js 的
     *  templateRefIssue 是这条窗口的唯一实现），min/max 只是模型层的最后兜底 */
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

// ── 白模 V2：角色位 ───────────────────────────────────────────────────
// 「白模人偶胸口那个编号 ↔ 原视频里的哪个人」。**缺省 = V1 老模板**（整段只有一个
// 红色小人，没有角色位）—— 所以判据一律是**存在性**（`roles?.length`），不是等值。
//
// ★★ 为什么这份映射非存不可：白模化那一发的产物是「一群带编号的白人偶」，编号本身
//   没有含义。套用者要在编辑页点"1 号位"给它挂人物卡，得先知道 1 号位原来是谁
//   （"穿黑袍的白发少年"）。没有这份映射，编号就只是一堆数字，用户只能靠猜。
// ★ label 是**字符串**不是序号：2026-08-15 实测（F5）方舟给出的编号清晰稳定、
//   跨帧不串号，但**不连续**（实出 1/2/4/5）。写成数组下标或假设 1..N 都会错位。
const roleSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 8 },
    desc: { type: String, default: "", trim: true, maxlength: 300 },
    /**
     * 「这个编号是**作者对着成片核对过**的吗」。
     *
     * ★★ 为什么非有这一位不可（F5 的直接后果）：落库那一刻的 label 是**服务端按视觉
     *   清单顺序编的猜测**（1..N），而成片上人偶胸口的数字**不保证连续**（实出 1/2/4/5）。
     *   两者一旦错位，画面上的 4 号在列表里就登记成 3 —— 套用者按编号挂卡时，
     *   张三被换到别人身上，**钱照扣、零报错**（模型不会拒绝一个"合法但指错人"的编号）。
     *   所以：AI 报的编号只是草稿，**必须由作者看着成片确认**（PATCH /templates/:id/roles），
     *   确认前不许发布（闸门在 routes 的 publish，判据只有下面的 rolesNeedConfirm 一处）。
     * ★ default false 而不是缺省：新建的 V2 模板一律"未核对"。本次之前建的存量 V2 模板
     *   读到 `undefined`，`rolesNeedConfirm` 用 `!== true` 判它 —— 判成"未核对"正是事实
     *   （它们的编号确实从没有人核对过），往安全那一侧退。
     */
    labelConfirmed: { type: Boolean, default: false },
  },
  { _id: false }
);

// 白模化的来源（溯源与重做用）。★ **不出现在公开响应里**：它指向作者自己上传的
// 原始素材（可能是有版权的片子），把 public_id 发给每个逛市场的人没有任何正当用途。
const sourceSchema = new mongoose.Schema(
  {
    /** 用户原视频的 Cloudinary public_id（`ideahub/template-videos/<userId>-<ts>`） */
    publicId: { type: String, required: true, trim: true, maxlength: 300 },
    /** 编辑页框选的那一段（整数秒）与画面裁剪框（整数像素）。
     *  ★ 这四组数是**服务端拼变换 URL 时用的那一份**，不是客户端报的镜像 ——
     *    重做时照它再拼一次必须得到逐字相同的地址。 */
    startSec: { type: Number, required: true, min: 0 },
    durSec: { type: Number, required: true, min: 1 },
    crop: {
      x: { type: Number, required: true, min: 0 },
      y: { type: Number, required: true, min: 0 },
      w: { type: Number, required: true, min: 1 },
      h: { type: Number, required: true, min: 1 },
    },
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
    /** 角色位（白模 V2）。**服务端写**：来自白模化那一步 chat vision 的清单，
     *  客户端提交的一律不收（与 refVideo 元数据同一条理由，schema 里压根没这个字段）。
     *  V1 老模板没有这一项 —— 判它一律用存在性，别用 `=== []` 之类的等值 */
    roles: { type: [roleSchema], default: undefined },
    /** 白模化的来源。服务端写，且**不出公开响应** */
    source: { type: sourceSchema, default: undefined },
    /**
     * 建出这个模板的那张**取件凭据**（models/BlockoutJob）。V1 与 V2 一体式那阵子建的
     * 模板没有这一项 —— 判它一律用存在性。同样**不出公开响应**（纯内部）。
     *
     * ★★ 它存在的唯一理由是**幂等**：白模 V2 拆成两阶段之后，「取回结果」（finish）是
     *   一条**可以重来**的路（转存失败、用户手抖点两次、两台 pm2 实例同时收到）。
     *   下面 refVideo.url 的唯一索引挡不住这种重来 —— 每次转存都是一次新的 Cloudinary
     *   上传，**secure_url 里带着新的 version**，两条 URL 并不相等，于是同一发白模化会
     *   建出两个模板（还各占一份 100MB 级的资产）。所以"一张取件单只许建一个模板"
     *   必须由**数据库**来保证，而不是靠代码里那句 if。
     * ★ sparse：没有这一项的老模板不该白占索引条目（也不该被当成"同一张凭据"互相冲突）。
     */
    blockoutJobId: { type: mongoose.Schema.Types.ObjectId, ref: "BlockoutJob", default: undefined },
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

/**
 * 「这个模板的角色位编号还等着作者核对吗」—— **这条判据的唯一实现**（铁律六）。
 * 消费方：publish 闸门、PATCH /roles 的幂等判断、以及以后任何"能不能拿去套用"的门。
 *
 * @param {{ roles?: Array<{ labelConfirmed?: boolean }> }|null} doc 文档或 lean 对象都行
 * @returns {boolean} true = 还没核对，不许发布
 *
 * ★ V1 老模板（没有 roles）**返回 false**：它整段只有一个红色小人、没有编号这回事，
 *   这道门与它无关。判据写**存在性**（`roles?.length`），不是等值 —— 拿
 *   `roles === undefined` 之外的形状（空数组、null）去比都会把 V1 误判成"待核对"，
 *   而那表现为"老模板突然发布不了了"，且完全指不到这里。
 * ★ 逐项 `!== true`：只有明确写着 true 才算核对过。存量 V2 模板那一项是 `undefined`，
 *   按未核对处理（见 roleSchema.labelConfirmed 的 ★）。
 */
branchTemplateSchema.statics.rolesNeedConfirm = function rolesNeedConfirm(doc) {
  const roles = doc?.roles;
  if (!Array.isArray(roles) || roles.length === 0) return false;
  return roles.some((r) => r?.labelConfirmed !== true);
};

/** 未核对时给用户看的整句理由。**与判据放在一起**：两处分家的话会出现
 *  "拦住了但说的是别的事"（铁律八要的是"响且说得清"，不是只响）。 */
branchTemplateSchema.statics.ROLES_CONFIRM_HINT =
  "请先核对每个角色位的编号与画面上人偶胸口的数字是否一致：" +
  "AI 报的编号只是草稿（实测人偶编号稳定但不连续，可能是 1/2/4/5），" +
  "对不上的话，套用你模板的人会把角色卡挂到别人身上，而且不会有任何报错。";

// r2v 结算按参考视频 URL 反查登记（ark.routes.js 的 resolveR2v），一条 URL 只许一个模板。
// url 是服务端规范化过的 secure_url（见上），所以这条唯一索引挡得住变体绕过。
branchTemplateSchema.index({ "refVideo.url": 1 }, { unique: true });
// 「我的模板」按新旧排
branchTemplateSchema.index({ ownerId: 1, createdAt: -1 });
// 孤儿回收要问「这段原始素材还有模板在引用吗」（uploads.routes 的 DELETE /template-video）。
// sparse：V1 模板没有 source，不该白占索引条目
branchTemplateSchema.index({ "source.publicId": 1 }, { sparse: true });
// ★★ 一张白模取件凭据只许建出**一个**模板（幂等的最后一道兜底，理由见 blockoutJobId 的 ★★）。
// unique+sparse：老模板（没有这一项）不参与这条约束。
branchTemplateSchema.index({ blockoutJobId: 1 }, { unique: true, sparse: true });
// 市场列表：只查 published，按新旧排
branchTemplateSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("BranchTemplate", branchTemplateSchema);
