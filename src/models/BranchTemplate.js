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
    /** r2v 结算的输入时长（秒，**整数**）。参考视频窗口 [4,30]（middleware/upload.js 的
     *  templateRefIssue 是这条窗口的唯一实现），min/max 只是模型层的最后兜底。
     *
     *  ★★ 含义 2026-08-16 一个字没变，仍然是**计价锚点**、仍然是整数 —— 变的只有
     *    产生方式：`Math.round(真实秒数)` → `Math.ceil(真实秒数)`（见 routes 里 finish
     *    那一步的 ★★）。为什么不改成小数：App 的 r2vTokens（economy.ts）**不 round
     *    不 clamp**，服务端的（config/tokens.js）round+clamp —— 存整数时两者恒等，
     *    存小数的那一刻起就是"页面报少、钱包扣多"，本仓头号事故形状。 */
    durationSec: { type: Number, required: true, min: 1, max: 60 },
    /**
     * 云端回执里那个**真实时长**（小数，秒）。**只读、只由服务端写、不参与任何计价**。
     *
     * ★★ 为什么要新增一个字段而不是把 durationSec 改成小数：见上面那条 ★★。
     *   这一位存在的意义是**诊断与如实展示** —— 白模产出比输入短（2026-08-16 实测
     *   4.0→3.712），锚点是 ceil 出来的整数，两者本来就不等；不存真值的话，
     *   "这个模板到底能不能用"（产物是否 ≥ 方舟的 4 秒下限）在库里就无从判断，
     *   只能等每一个套用者去撞方舟的英文 400。
     * ★ **不给 required、不给 default**：存量模板（V1 与老 V2）天然没有这一项，
     *   读它一律用存在性 + 否定式（`typeof x === "number" && x < 4` 才算坏），
     *   缺失一律当好 —— 用肯定式判会把存量整批误判，且不报错。
     * ★ 客户端永远不许发它：zod body schema 里刻意没有这个字段（z.object 默认 strip），
     *   与 durationSec/width/height 同一条理由。
     */
    realDurationSec: { type: Number, min: 0 },
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
// 「人偶身上那个标记 ↔ 原视频里的哪个人」。**缺省 = V1 老模板**（整段只有一个
// 红色小人，没有角色位）—— 所以判据一律是**存在性**（`roles?.length`），不是等值。
//
// ★★ 标记有两代，靠模板上的 `markColors` 存在性分辨（见下面 isColorMark）：
//   · **编号方案（老）**：人偶通体白色，头上印阿拉伯数字，label 是 "1".."9"。
//     2026-08-16 起不再产出，但**线上已有的模板还在用，绝不能被误判**。
//   · **颜色方案（新）**：一个角色位一种颜色、人偶通体一色，label **本身就是色名**
//     （"绿色"…，出处 services/blockoutize.MARK_PALETTE）。
//   换代的理由是实测：编号被模型当成"贴在当前这一帧上的二维贴纸"，不维持跨帧对象
//   恒等性 —— 转身就读不到、同一个人偶正背两个号、还会被复刻进成片；颜色是**材质**，
//   任何角度都对。详见 blockoutize.service 的 blockoutPrompt 函数头。
//
// ★★ 为什么这份映射非存不可：白模化那一发的产物是「一群没有五官的人偶」，标记本身
//   没有含义。套用者要在编辑页点"绿色位"给它挂人物卡，得先知道绿色位原来是谁
//   （"穿黑袍的白发少年"）。没有这份映射，标记就只是一堆颜色，用户只能靠猜。
// ★ label 是**字符串**不是序号，两代都如此：编号时代实测方舟给的号**不连续**
//   （实出 1/2/4/5），颜色时代它干脆是汉字。写成数组下标或假设 1..N 都会错位。
// ★★ 一个角色位**只有一个身份**：label 就是那个 token，不许再另设一个 `color` 字段。
//   两个 ID 一旦能互相矛盾（作者能通过 PATCH /roles 改 label），就没有任何人能仲裁 ——
//   与被推翻的"胸口 + 头部两处印号"是同一个形状。
const roleSchema = new mongoose.Schema(
  {
    // ★ maxlength 8 对两代都够：数字 1 位、色名 2 个汉字（MARK_PALETTE 选色规则⑦
    //   就是照着这个 8 定的，所以换颜色时这三处 maxlength 一个都没动）
    label: { type: String, required: true, trim: true, maxlength: 8 },
    desc: { type: String, default: "", trim: true, maxlength: 300 },
    /**
     * 「这个标记是**作者对着成片核对过**的吗」。
     *
     * ★★ 为什么非有这一位不可：落库那一刻的 label 是**服务端按视觉清单顺序发的猜测**
     *   （编号时代是 1..N，颜色时代是调色板前 N 种），而成片上人偶身上的标记不保证
     *   与它逐一对应 —— 编号实测不连续（1/2/4/5）、还会重号；颜色实测命中率只有 ~57%
     *   （最常见的两种错：正中央那个"最像主角"的人根本没被人偶化、相邻两色互换）。
     *   两者一旦错位，套用者按标记挂卡时张三被换到别人身上，**钱照扣、零报错**
     *   （模型不会拒绝一个"合法但指错人"的标记）。
     *   所以：AI 发的标记只是草稿，**必须由作者看着成片确认**（PATCH /templates/:id/roles），
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
     *  V1 老模板没有这一项 —— 判它一律用存在性，别用 `=== []` 之类的等值。
     *
     *  ★ **唯一的例外**是作者的编号核对（PATCH /templates/:id/roles）：那条路整份替换
     *    这个数组，所以**这份清单的长度是会变的** —— 作者能补一条（视觉少认了一个人），
     *    也能删掉一条（实测方舟会印重号、也会漏号：一段 5 人素材实出 2/2/1/1/5，
     *    画面上找不到的那个号只能删）。任何按 `roles.length` 推"画面上有几个人"
     *    或按下标推编号的写法都会在那之后错，且不报错。
     *  ★ 删位之后**剩下的 label 逐字不动**（不重编、不排序）：label 就是画面上那个
     *    标记本身（老模板是数字、新模板是色名），也是这个子文档的全部身份（`_id: false`）。
     *    重编 = 把卡挂到别人身上。
     *    下限"至少留一个"由路由 handler 判（那里说得出人话），不在这里也不在 zod。 */
    roles: { type: [roleSchema], default: undefined },
    /**
     * 阶段一发白模化提示词时**真正写进那段话的那份颜色清单**（逐字、按序，
     * 如 `["绿色","黑色","蓝色","紫色","红色"]`）。由 finish 从取件凭据原样搬过来。
     *
     * ★★ **存在且非空 = 颜色方案；缺失/空/null 一律回落编号方案**（判据只有下面的
     *   `isColorMark` 一处）。这是本次换代的头号红线：线上那两个好模板
     *   （「都市主角群舞转场」「宗主垫脚舞」）天然没有这一位 → 判成编号方案 →
     *   套用侧走老提示词 → **一个字都不受影响**。反过来写成 `!== "color"` 走颜色路，
     *   会把存量整批翻面（画面上根本没有绿色人偶，套用当场作废），且零报错。
     *   后加的字段判否定 —— visibility 那条坑的同一条规则。
     *
     * ★ **不可变**：`PATCH /roles` 只写 `doc.roles`，永远不碰它。让作者改得动方案位
     *   = 让他把一个颜色模板标成编号模板，套用侧当场整份错，且零报错。
     *   所以 zod 的 patchRolesBody 里刻意没有这一位（z.object 默认 strip 是帮手）。
     *
     * ★★ 为什么是「颜色清单」而不是一个 `markScheme: enum["number","color"]`：
     *   一个字段能回答的问题，两个字段就能互相矛盾。这一份除了"是不是颜色方案"，
     *   还额外给出四件今天真的需要的东西 ——
     *     ① 核对面板颜色选择器的候选集（**必须**限定在这一段视频里真实存在的那几种色，
     *        否则作者能选到一个画面上根本没有的颜色，造出一个永远挂不上也永不报错的死位子）；
     *     ② 作者误删一个角色位之后能把它**加回来**（编号方案下这是白送的，颜色方案下
     *        没有这一位就永久丢失）；
     *     ③ 文案能说准"这段视频里只有这 N 种颜色"（删位之后从 roles 推会是错的）；
     *     ④ 排障时能逐字复现当初发出去的那句枚举。
     *   将来真出现第三种方案，那时再加枚举并做一次迁移；现在加就是给同一个问题两个答案。
     */
    markColors: { type: [String], default: undefined },
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
 * 「判这个模板的视频合不合方舟窗口时，该拿哪个秒数」—— **这条口径的唯一实现**（铁律六）。
 *
 * 消费方三处，必须读同一个数，否则会出现"发布闸放行、套用闸拒绝"这种自相矛盾：
 *   · 发布闸（routes/branchTemplate 的 PATCH /publish）
 *   · 套用闸（routes/ark 的 resolveR2v 分支一）
 *   · 迁移/巡检脚本
 *
 * ★★ 优先 realDurationSec（真实小数），退回 durationSec（ceil 出来的计价锚点）。
 *   为什么不能只看 durationSec：它是**向上取整**的，一段 3.712s 的坏产物在那里写着 4，
 *   光看那个数**看不出坏** —— 线上那 3 个废模板就是这么隐身的。
 * ★ 后加的字段判**存在性**：老模板没有 realDurationSec，退回锚点当好数用，
 *   绝不因为"没有这一项"就判成坏的（判否定，本仓 visibility 那条坑的同一条规则）。
 * @returns {number|null} 有效秒数；两个都拿不到（理论上不可能，refVideo 必填）时 null
 */
branchTemplateSchema.statics.refVideoSec = function refVideoSec(refVideo) {
  const real = Number(refVideo?.realDurationSec);
  if (Number.isFinite(real) && real > 0) return real;
  const anchor = Number(refVideo?.durationSec);
  return Number.isFinite(anchor) && anchor > 0 ? anchor : null;
};

/**
 * 「这个模板是**颜色方案**吗」—— **这条判据的唯一实现**（铁律六）。
 *
 * 消费方：核对提示的措辞（下面的 rolesConfirmHint）、重号提示、出响应时要不要带
 * `markColors`、以及 App 侧套用提示词走哪一套（判据由服务端下发，客户端只读不写 ——
 * **谁发的白模化提示词，谁记这个模板是什么方案**）。
 *
 * @param {{ markColors?: unknown }|null} doc 文档或 lean 对象都行
 * @returns {boolean} true = 颜色方案（人偶通体一色，label 是色名）
 *
 * ★★ **只有明确带着非空 markColors 才算颜色方案**。缺失、空数组、null 一律回落编号
 *   方案 —— 线上那两个好模板天然没有这一位，判成编号 → 套用走老提示词 → 零影响。
 *   这就是"判否定"：危险的那个方向（把存量误判进新方案）在结构上走不通。
 * ★ 别写成 `doc.markColors !== undefined`：空数组是"这一位被写坏了"的形状，
 *   它也必须往安全那一侧退（编号）。
 */
branchTemplateSchema.statics.isColorMark = function isColorMark(doc) {
  return Array.isArray(doc?.markColors) && doc.markColors.length > 0;
};

/**
 * 「这个模板的角色位标记还等着作者核对吗」—— **这条判据的唯一实现**（铁律六）。
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

/**
 * 未核对时给用户看的整句理由 —— **按方案给两句**。
 *
 * ★ **与判据放在一起**：两处分家的话会出现"拦住了但说的是别的事"
 *   （铁律八要的是"响且说得清"，不是只响）。
 * ★★ 这句话要指到**用户真能看到标记的那个地方**，否则一句过时的指路和一个坏功能
 *   长得一模一样。两代各有各的实话，两句都不许再抄对方那一半：
 *   · 颜色版：颜色是**材质**，转身/侧对/被挡住再露出来都还是那个颜色 —— 实测成立；
 *   · 编号版：⑦ 已经证实「头部四面都是同一个数」**从来没有被执行过**（每发只印一面，
 *     且哪一面不可控）。老措辞里那句"转到哪一面都是同一个号"是全 app 最硬的假承诺，
 *     作者照着它转一圈找不到号，只会以为是生成坏了。这里改成实话 —— 不改机制、
 *     只改指路（老模板本身照旧可用，不用重做）。
 *
 * @param {{ markColors?: unknown }|null} doc
 */
branchTemplateSchema.statics.rolesConfirmHint = function rolesConfirmHint(doc) {
  if (this.isColorMark(doc)) {
    return (
      "请先核对每个角色位的颜色与画面上人偶的颜色是否对得上（颜色是整个人偶的材质，转身、侧对、被别人挡住再露出来，都还是那个颜色）：" +
      "AI 分配的颜色只是猜测（实测最常见的两种错是「画面正中央那个最像主角的人根本没被换成人偶」和「相邻两个颜色互换」），" +
      "对不上的话，套用你模板的人会把角色卡挂到别人身上，而且不会有任何报错。"
    );
  }
  return (
    "请先核对每个角色位的编号与画面上人偶头上的数字是否一致（编号只印在人偶的某一面，多半是额头或后脑，转过身可能就看不见了——拖动进度条找到能看清号的那一帧再核对）：" +
    "AI 报的编号只是草稿（实测人偶编号稳定但不连续，可能是 1/2/4/5），" +
    "对不上的话，套用你模板的人会把角色卡挂到别人身上，而且不会有任何报错。"
  );
};

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
