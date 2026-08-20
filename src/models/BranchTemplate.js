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
// ★★ 标记有两代，靠模板上的 `markSlots` 存在性分辨（见下面 isOrdinalMark）：
//   · **编号方案（老）**：人偶通体白色，头上印阿拉伯数字，label 是 "1".."9"。
//     2026-08-16 起不再产出，但**线上已有的模板还在用，绝不能被误判**。
//   · **序数方案（新）**：所有人偶**完全相同的纯白**，身上一个记号都没有，靠"从左往右
//     第几个"指认，label **本身就是那句措辞**（"最左边"/"从左数第3个"/"最右边"，
//     出处 services/blockoutize.ordinalSlots）。
//   换代的理由是实测：编号被模型当成"贴在当前这一帧上的二维贴纸"，不维持跨帧对象
//   恒等性 —— 转身就读不到、同一个人偶正背两个号、还会被复刻进成片。中间还有过一版
//   「一位一色」（命中率仅 ~57%，线上没产出过任何模板，2026-08-17 整条删掉）。
//   全白之所以更稳：它**不要求模型维持任何绑定**。详见 blockoutize.service 的
//   blockoutPrompt 函数头。
//
// ★★ 为什么这份映射非存不可：白模化那一发的产物是「一群一模一样、没有五官的白人偶」，
//   位置本身没有含义。套用者要在编辑页点"从左数第3个"给它挂人物卡，得先知道那个位子
//   原来是谁（"穿黑袍的白发少年"）。没有这份映射，画面上就只剩一排白人偶，用户只能靠猜。
// ★ label 是**字符串**不是序号，两代都如此：编号时代实测方舟给的号**不连续**
//   （实出 1/2/4/5），颜色时代它干脆是汉字。写成数组下标或假设 1..N 都会错位。
// ★★ 一个角色位**只有一个身份**：label 就是那个 token，不许再另设一个 `color` 字段。
//   两个 ID 一旦能互相矛盾（作者能通过 PATCH /roles 改 label），就没有任何人能仲裁 ——
//   与被推翻的"胸口 + 头部两处印号"是同一个形状。
const roleSchema = new mongoose.Schema(
  {
    // ★ maxlength 8 对两代都够：数字 1 位、序数措辞最长 `从左数第9个` = 6 字
    //   （ordinalSlots 措辞规则⑥ 就是照着这个 8 定的，所以两次换代这三处 maxlength
    //   一个都没动 —— 上一代靠"色名 2 汉字"吃住同一个 8，是同一个巧合）
    label: { type: String, required: true, trim: true, maxlength: 8 },
    desc: { type: String, default: "", trim: true, maxlength: 300 },
    /**
     * 「这个标记是**作者对着成片核对过**的吗」。
     *
     * ★★ 为什么非有这一位不可：落库那一刻的 label 是**服务端按视觉那一步的清单发的猜测**
     *   （编号时代是 1..N，序数时代是按视觉估的横向位置排出来的名次），而成片上那几个
     *   人偶不保证与它逐一对应 —— 编号实测不连续（1/2/4/5）、还会重号；序数则要看视觉
     *   估的横向位置准不准，以及有没有中途入场的路人把后面所有人的序数挤走一位。
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
    /**
     * 长视频分段登记的归组（2026-08-20）。缺省 = 独立模板（存量数据/整段登记）——
     * 判它一律用**存在性**（后加字段铁律）。每段是物理独立的 Cloudinary 资产 +
     * 一条普通模板记录，识别/挂卡/出片对"段"零特殊分支；这个子文档只回答
     * "你的兄弟是谁、你排第几、原片在哪（合并时要拿原片音轨）"。
     * sourcePublicId 只做"同一段源视频别登记两次"的判重，payload 刻意不出它
     * （与 source 同一条隐私理由）。
     */
    group: {
      type: new mongoose.Schema(
        {
          key: { type: String, required: true },
          index: { type: Number, required: true, min: 0 },
          count: { type: Number, required: true, min: 2 },
          sourceUrl: { type: String, default: "", trim: true, maxlength: 2000 },
          sourcePublicId: { type: String, default: "", trim: true, maxlength: 300 },
          sourceDurationSec: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: undefined,
    },
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
     * 这一段视频里**一共有哪几个可寻址的位置**，逐字、按画面从左到右（如
     * `["最左边","从左数第2个","最右边"]`）。由 finish 从取件凭据原样搬过来，
     * 而凭据里那一份就是阶段一 `roles.map(r => r.label)`。
     *
     * ★★ **存在且非空 = 序数方案；缺失/空/null 一律回落编号方案**（判据只有下面的
     *   `isOrdinalMark` 一处）。这是换代的头号红线：线上那 6 个存量模板天然没有这一位
     *   → 判成编号方案 → 套用侧走老提示词 → **一个字都不受影响**。反过来写成
     *   `!== "ordinal"` 走序数路，会把存量整批翻面（画面上的人偶头上印的是数字，
     *   套用当场作废），且零报错。后加的字段判否定 —— visibility 那条坑的同一条规则。
     *
     * ★ **不可变**：`PATCH /roles` 只写 `doc.roles`，永远不碰它。让作者改得动方案位
     *   = 让他把一个序数模板标成编号模板，套用侧当场整份错，且零报错。
     *   所以 zod 的 patchRolesBody 里刻意没有这一位（z.object 默认 strip 是帮手）。
     *
     * ★★ 为什么是「措辞清单」而不是一个 `markScheme: enum["number","ordinal"]`：
     *   一个字段能回答的问题，两个字段就能互相矛盾。这一份除了"是不是序数方案"，
     *   还额外给出四件今天真的需要的东西 ——
     *     ① 核对面板序数选择器的候选集（**必须**限定在这一段视频里真实登记过的那几个位置，
     *        否则作者能选到一个根本不存在的位子，造出一个永远挂不上也永不报错的死位子）；
     *     ② 作者误删一个角色位之后能把它**加回来**（编号方案下这是白送的，序数方案下
     *        没有这一位就永久丢失）；
     *     ③ 文案能说准"这段视频里一共有 N 个可挂卡的位置"（删位之后从 roles 推会是错的）；
     *     ④ **App 拼套用提示词时按 `markSlots.indexOf(label)` 升序排**——这是承重的：
     *        实测同样 3 张卡，只把书写顺序从升序改成乱序，5 个位子里就错了 3 个。
     *        排序不需要解析中文，只需要在这份清单里查下标（与"App 侧一个措辞常量都不许有"
     *        完全同构）。
     *   将来真出现第三种方案，那时再加枚举并做一次迁移；现在加就是给同一个问题两个答案。
     *
     * ⚠⚠ **label 存的是措辞本身，不是序位数字**，这一条是刻意的：万一哪天有人漏搬了
     *   这一位（本仓已经因为"逐字段重建"咬过三次），套用侧会写出 `编号从左数第3个=凛`
     *   —— **一眼就是坏的，而且摆在花钱之前的可编辑输入框里**。若存的是 "3"，
     *   漏搬的后果是 `编号3=凛`，与存量编号模板形状完全相同、完全看不出来。
     */
    markSlots: { type: [String], default: undefined },
    /**
     * 每个角色位在**产物某一帧**上的画面框（归一化 0~1000 的中心点 + 宽高），
     * 与 `markSlots` **按下标一一对应**。App 靠它开「把卡拖到那个人偶身上」那条路。
     *
     * ★★ 判存在性、且**长度必须等于 markSlots**（服务端只在相等时才写、App 收货时
     *   再独立校一次）。少一个框我们就不知道少的是哪一个 —— 按顺序硬配等于把后面
     *   每一个都错开一位，而挂错人是零报错的。两端各校一次不是重复实现，是网络
     *   两端互不信任的边界检查。
     * ★ 它是**尽力而为**的一位：量框那一发失败/数目对不上就整份不写，模板照建、
     *   拖拽层关掉、点列表照常用。绝不因为"框没量出来"就让一次已经付过费的白模化失败。
     * ⚠ 框量在**产物**上（不是原视频）—— 两段视频时间轴对不齐、画面也是重新生成的，
     *   理由写在 blockoutize.service 的 ①e。
     */
    markBoxes: {
      type: [
        {
          _id: false,
          cx: { type: Number, required: true },
          cy: { type: Number, required: true },
          w: { type: Number, required: true },
          h: { type: Number, required: true },
        },
      ],
      default: undefined,
    },
    /**
     * 上面那些框量自产物的第几秒。**没有它就等于没有框**（App 侧两者缺一整层关掉）：
     * 框是**一帧**上量的、人是会走动的，不知道是哪一帧就只能画一组随时可能过时的框，
     * 而用户会照着它拖。取法的唯一实现是 blockoutize.service 的 `boxFrameSec`。
     */
    markBoxAtSec: { type: Number, default: undefined },
    /**
     * 「怎么在**白模视频本身**里认出第 i 个位置上那个人偶」——与 `markSlots` 按下标一一对应，
     * 与 `markBoxes`（它在**哪儿**）是同一族的另一位（它长什么样、在干什么）。
     * 内容形如 `白色、弯腰前倾，双手下垂、在左数第二条白条纹左侧`（颜色、动作、与景物的位置关系）。
     *
     * ★★★ **它与 `roles[].desc` 不是同一件事，别合并**（2026-08-18 花了一发实拍才看清）：
     *   · `roles[].desc` 回答的是「这个位子**原来**是谁」——V2 白模化那条路它来自**原片**
     *     （「白发黑袍的少年」），是给作者核对、给套用者挑卡看的；
     *   · `markDescs[i]` 回答的是「**现在这段白模视频里**那个人偶什么样」，是写进套用提示词、
     *     给 r2v 用来指认的。
     *   合成一位的后果**当场就有**：V2 模板会拼出「从左数第2个（白发黑袍的少年）=阿岚」，
     *   而参考视频那个位置站着一个一模一样的白人偶 —— 最坏的情况是模型照着括号里那句话
     *   把白模化**之前**那个人画回来。
     *
     * ★★ **只有拿得出"在白模视频里验过唯一性"的描述时才写这一位**（今天只有
     *   「自己传白模视频」那条路，detect-roles）。V2 白模化那条路**不写** ——
     *   它的认人看的是原片，那份描述在产物里根本不成立。⇒ 判存在性，缺失 = 老数据/别的路，
     *   套用侧退回"只有序数"的老形状，与今天逐字相同。
     * ★ 单个元素允许是空串：那表示"这个位子的描述没通过唯一性自证"（只认出个颜色，
     *   而颜色在全白素材上 5 个人里只能区分 1 个）。套用侧对空串**不拼括号** ——
     *   一句"7 个人里 6 个都符合"的话进了提示词是纯噪音，2026-08-18 那一发验的就是这个。
     * ⚠ 长度必须等于 `markSlots`，理由与 markBoxes 逐字相同（少一个就整份错位，零报错）。
     */
    markDescs: { type: [String], default: undefined },
    /**
     * 「这条模板正在认角色位」的**并发锁**（`POST /templates/:id/detect-roles` 抢它）。
     *
     * ★★ 必须在 schema 里声明：mongoose 默认 strict，**没声明的路径在 update 里会被
     *   静默丢掉** —— 那样这把锁写不进去、每次抢都成功，两发并发各扣一次钱，
     *   而全程零报错（与 server 那条「zod strip 掉未声明字段」是同一个形状）。
     * ★ 存的是**时间戳而不是布尔**：进程被杀、请求中断时布尔会把这条模板永久锁死，
     *   而时间戳能自己过期（路由里判 `< now - DETECT_LOCK_MS`）。
     * ★ `default: undefined` + 判存在性：这个字段上线之前的存量模板没有它，
     *   于是第一次抢锁必然成功 —— 正确。
     */
    detectingAt: { type: Date, default: undefined },
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
 * 「这个模板是**序数方案**吗」—— **这条判据的唯一实现**（铁律六）。
 *
 * 消费方：核对提示的措辞（下面的 rolesConfirmHint）、重号提示、出响应时要不要带
 * `markSlots`、以及 App 侧套用提示词走哪一套（判据由服务端下发，客户端只读不写 ——
 * **谁发的白模化提示词，谁记这个模板是什么方案**）。
 *
 * @param {{ markSlots?: unknown }|null} doc 文档或 lean 对象都行
 * @returns {boolean} true = 序数方案（人偶全白且完全相同，label 是位置措辞）
 *
 * ★★ **只有明确带着非空 markSlots 才算序数方案**。缺失、空数组、null 一律回落编号
 *   方案 —— 线上那 6 个存量模板天然没有这一位，判成编号 → 套用走老提示词 → 零影响。
 *   这就是"判否定"：危险的那个方向（把存量误判进新方案）在结构上走不通。
 * ★ 别写成 `doc.markSlots !== undefined`：空数组是"这一位被写坏了"的形状，
 *   它也必须往安全那一侧退（编号）。
 */
branchTemplateSchema.statics.isOrdinalMark = function isOrdinalMark(doc) {
  return Array.isArray(doc?.markSlots) && doc.markSlots.length > 0;
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
 *   · 序数版：人偶全都一模一样，身上一个记号都没有 —— 作者要做的是**从左往右数**；
 *   · 编号版：⑦ 已经证实「头部四面都是同一个数」**从来没有被执行过**（每发只印一面，
 *     且哪一面不可控）。老措辞里那句"转到哪一面都是同一个号"是全 app 最硬的假承诺，
 *     作者照着它转一圈找不到号，只会以为是生成坏了。这里改成实话 —— 不改机制、
 *     只改指路（老模板本身照旧可用，不用重做）。
 *
 * ★★ 序数版那句**必须带上"删位会让右边的序数整体挪一位"**：这是序数方案**独有**的
 *   失效模式（编号/颜色都印在人身上，删一行不影响别人）。不说这句话，作者删掉一个
 *   画面上不存在的位子之后，剩下的位子会静默整份错位，而他以为自己刚把模板修好了。
 *
 * @param {{ markSlots?: unknown }|null} doc
 */
branchTemplateSchema.statics.rolesConfirmHint = function rolesConfirmHint(doc) {
  if (this.isOrdinalMark(doc)) {
    return (
      "请先对着画面**从左往右数**，核对每个角色位的位置与画面上的人偶是否对得上（这一版的人偶全都是一模一样的纯白色，身上没有任何记号，只能靠「从左数第几个」指认）：" +
      "AI 分配的位置只是猜测，对不上的话，套用你模板的人会把角色卡挂到别人身上，而且不会有任何报错。" +
      "另外：如果某个位子在画面上根本找不到对应的人偶，删掉它之后，它右边那些位子要整体往左挪一位——请顺手一起改。"
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
// 取兄弟段用（applyGroup 一次拉全组）。sparse：绝大多数模板没有 group
branchTemplateSchema.index({ "group.key": 1 }, { sparse: true });
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
