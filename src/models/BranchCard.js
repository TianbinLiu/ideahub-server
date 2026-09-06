// src/models/BranchCard.js
// 分支视频 · 用户卡片（人物/场景/背景/道具/风格）。
// cardId 是客户端生成的稳定 id（工坊炼卡 `card_*`、市场卡 `mkt_*`），
// 服务端不重新发号，靠 { owner, cardId } 唯一索引做批量新增的幂等。
// cover 入库前已由控制器把 dataURL 转存成 Cloudinary 永久 URL（转存失败降级保留原值，
// 所以这里不给 cover 设 maxlength，避免 dataURL 兜底时被 mongoose 校验拦下）。
// ★ Mongoose 9 的 pre hook 不接收 next——本模型刻意不写任何 hook。
const mongoose = require("mongoose");
// 类型枚举只在 schemas/branchAsset.schemas.js 定义一份，避免改一处漏一处（表现是整批加卡 400）
const { CARD_TYPES } = require("../schemas/branchAsset.schemas");
// 多图参考的子文档形状与 BranchDeck 的快照共用同一份（见那个文件的文件头）
const { cardViewSchema } = require("./cardView.schema");

// 肖像授权绑定的子文档（字段释义见下面 portrait 那条注释）
const portraitSchema = new mongoose.Schema(
  {
    assetId: { type: String, required: true, trim: true, maxlength: 64 },
    scope: { type: String, enum: ["private", "public"], default: "private" },
    note: { type: String, default: "", trim: true, maxlength: 200 },
    boundAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const branchCardSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    cardId: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: CARD_TYPES, default: "prop" },
    name: { type: String, default: "", trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 2000 },
    cover: { type: String, default: "" },
    // ⚠ hot 是**客户端发来的**种子热度，只做展示兜底，不再是「热度」的判据。
    //   真热度按 { kind:"card", key:cardId } 存在 BranchAssetStat 里，由服务端算。
    //   留着这个字段是为了兼容老客户端（它还在发），不接受它会整批加卡 400。
    hot: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    /** 3D 建模指针。可能是 `idb:model3d:*` 这种**只在卡主那台设备上有意义**的本地指针，
     *  所以发布/安装时会被剥掉（见 controller 的 shareableModelUrl） */
    modelUrl: { type: String, default: "" },
    /** 铸卡时的完整生成提示词（卡片详情页的「生成蓝图」） */
    genPrompt: { type: String, default: "" },
    /** 固定身份句（2026-08-28）：≤60 字「名字+2~3个不变的视觉特征」，客户端出片提示词
     *  直接用它（业界通行做法：长设定不进视频 prompt）。strict 模式下漏声明 = 落库时
     *  被剥掉且零报错（modelUrl/genPrompt 的旧伤），所以必须有名字 */
    idLine: { type: String, default: "", trim: true, maxlength: 200 },
    /** 画面里是真实人物——用户在圈选提取时自己勾的声明（像不像真人机器判不准，只能
     *  让当事人表态）。真人素材受供应商内容审核与深度合成法规约束，出片档位按它分流。
     *  缺省 false = 老卡/未声明 = 非真人（客户端读侧判否定，见 app 仓 types.Card.realPerson）。
     *  ⚠ 漏在这里的后果与 modelUrl 那次同形：zod 放行了、strict 模式落库时剥掉，零报错 */
    realPerson: { type: Boolean, default: false },
    /** 多图参考（最多 3 张，只可能是 http(s)）。喂给 Seedream 画方案首尾帧时锁形象。
     *  ★ 空数组与「字段不存在」在这里是**同一件事**（都表示"只有封面这一张形象"），
     *    所以 default 给 `[]` 而不是 undefined：客户端的归一（老卡 → 拿 cover 当唯一
     *    一张 body 图）只在 app 的 viewsOf() 一处做，服务端**不**替它补一份 ——
     *    补了就是同一条规则的第二处实现，两边一旦分叉，用户看到的参考图和真正喂给
     *    AI 的参考图会不是同一批，而这种偏差在结果里根本看不出来。 */
    views: { type: [cardViewSchema], default: [] },
    /**
     * 肖像授权绑定（方舟可信素材 `asset://<id>`）—— **随账号走，不随卡走**（2026-09-05）。
     * ★★ 为什么放在服务端：这条绑定原来只在 app 的本机侧库（IndexedDB）里 —— "授权给的是
     *   这个账号"，却落在"这一台设备的这一个安装"上。换机 / 重装 / 并排装了 debug 包再登录，
     *   卡从服务端回来了、绑定却没有，用户读到的是「退出再登录，授权就失效了」（2026-09-05
     *   主人真机）。app 侧库现在只是它的本机镜像（登录时以这一份为准装回去）。
     * ★★ 只有卡主自己读得到：toCardPayload（我的列表 / PATCH 回执）带它；
     *   toSharedCardPayload（广场）与 installCard（装到别人名下）**刻意不带** —— 资产绑死在
     *   平台的火山账号下、背后是某个真人的肖像授权，跟着卡走出去就是替被授权人做了一个
     *   他没同意的授权（与 realPerson 卡不许发布是同一条产品决定）。
     * ★ 缺省 undefined = 没绑过（读侧判否定，老文档没有这个字段）。解绑是 $unset，不是写空对象。
     */
    portrait: { type: portraitSchema, default: undefined },

    // ── 发布到创意工坊（与 BranchDeck 同一套语义）──
    /**
     * 这张卡是**从别人那儿来的**（从广场装的 / 跟着作品卡组、模板快照落库的）。
     * 有值 = 转发件，值是**原件主人**的 userId。
     *
     * ★★ 它只做一件事：挡住"把别人的卡再分享一遍"。为什么必须挡而不是署名转发 ——
     *   卡片的身份是**全局 cardId**，`{owner, cardId}` 唯一索引 + 广场按 cardId 去重
     *   （dedupeAuthoritative 取最早发布那条）⇒ 转发根本**没有第二行可放**：
     *   点了以后推荐语没人看得见、广场那行仍然是原作者的，而原作者想撤时还会被
     *   "已经有别人也发过"这件事搅乱。今天那颗能点的按钮是个**假承诺**。
     *   （卡组不同：每装一次生成一份新文档，广场天然多一行，所以那边能做 remixOf 署名。）
     * ★ **只由服务端写**：POST /cards 是逐字段重建 + zod z.object strip，客户端发不上来。
     *   ⚠ 别哪天顺手把它加进 addCardsBody —— 那等于让任何人自称原创者。
     * ★ 判否定：老数据没有这个字段 = 当作原创（不能把存量卡一夜之间全判成转发件）。
     */
    sourceOwner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date, default: undefined },
    description: { type: String, default: "", trim: true, maxlength: 200 },

    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// 幂等的地基：同一用户同一 cardId 只能有一条
branchCardSchema.index({ owner: 1, cardId: 1 }, { unique: true });
// 「我的卡片」按时间倒序列出
branchCardSchema.index({ owner: 1, createdAt: -1 });
// 卡片广场：只查已发布的，按发布时间倒序（与 BranchDeck 的广场索引同形）
branchCardSchema.index({ published: 1, publishedAt: -1 });

module.exports = mongoose.model("BranchCard", branchCardSchema);
