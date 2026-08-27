// src/schemas/branchAsset.schemas.js
// 分支视频 · 卡片/卡组请求校验（zod）。
// 注意 cover 可能是 Seedream 出图的 dataURL（很长），这里【不】限制长度，
// 由控制器转存成 Cloudinary URL；校验只保证类型正确。
//
// ⚠⚠ `z.object` 默认 **strip 未声明字段**。往客户端 Card / Deck 上加字段时，
//   五个地方必须一起加：这份 schema、models/BranchCard.js、models/BranchDeck.js 的
//   snapshotCardSchema、controller 的 toCardPayload/toDeckPayload、以及 app 仓的
//   api/branch.ts。漏任何一处的表现都是「客户端发了、服务端 201 了、读回来是空的，
//   全程零报错」——`deck` 与 `modelUrl` 都这么丢过。
//   ★ 2026-08-11 的 `views`（多图参考）少抄了一遍：它的子文档形状收在
//     models/cardView.schema.js 一处，两个 model 共用同一份 subschema。
const { z } = require("../middleware/validate");

// 卡片类型的唯一事实源：models/BranchCard.js 的 enum 也从这里取，
// 客户端对应 app/src/types.ts 的 CARD_TYPES（跨仓，改动要两边一起动）。
const CARD_TYPES = ["character", "scene", "background", "prop", "style"];

// 互动实体的种类与动作，models/BranchAssetStat.js 与 BranchAssetLike.js 的 enum 从这里取
const ASSET_KINDS = ["card", "deck"];
const ASSET_ACTIONS = ["like", "bookmark"];

// ── 多图参考（views）─────────────────────────────────────────────────
// 一张卡除封面外还能挂几张参考图。它们会被喂给 Seedream 去画方案的首尾帧
// （形象因此被烤进帧里，Seedance 仍然只按首尾帧出片 —— 方舟明说
//  「图生视频-首帧 / 首尾帧 / 全模态参考生视频是 3 种互斥场景，不可混用」）。
//
// ★ 上限 3 是**方舟提示词指南的建议**，不是拍脑袋：「不建议用满素材上限，
//   过多素材会导致模型难以判断特征优先级」。人物卡的推荐组合就是「面部特写 + 全身」。
// ★ kind 里**没有**"多视图/三视图"这种东西，也不要往那个方向引导用户：
//   同一人物的多角度素材会被模型识别成多个不同主体，反而加剧 ID 漂移
//   （方舟提示词指南原文）。道具/场景卡不存在这个问题（它们不是"主体身份"）。
const CARD_VIEW_KINDS = ["face", "body", "detail"];

// ── 灵活图位（role / tag）2026-08-24 ──────────────────────────────────
// 「提示词方案」让一张卡的图位不再固定成三格，于是要回答两个**不同**的问题：
//   · role —— 这张图在**出片管线**里干什么（机器读，受控词表）
//   · tag  —— 它在界面上叫什么（人读，自由文本，方案作者/用户起的花名）
//
// ★★ 为什么不动 kind：它是**跨仓冻结**的三值（app 的 types.CardView 同一条 ★★）。
//   加取值 = 老客户端/老服务端整批 400，而 app 那侧 emitApiError 没人监听 = 静默丢卡。
//   所以 kind 一个字不改，继续当"存储层与老客户端看的那一份"，客户端每次都照写
//   （由 role 反推）—— 老端拿到的仍是完全合法的三值数据，只是丢了花名：**降级不是损坏**。
// ★ role 缺省不写默认值：缺省本身就是"老数据，按 kind 推"（app 的 roleOf 一处实现）。
//   在这里补一个 default 等于**第二处默认值**，两边推法一旦分叉就是静默错配。
const CARD_VIEW_ROLES = ["face", "primary", "aux", "display"];
const CARD_VIEW_TAG_MAX = 24;
const MAX_CARD_VIEWS = 3;

// ★★ views[].url 只收 http(s)。这一条挡的是两件**性质不同**、都出过事的问题：
//   ① dataURL —— 一张卡三张 base64，卡组发布时会整个快照进 BranchDeck.cards，
//      `GET /decks` 一次返回全部快照就是几十 MB 的响应体。cover 走 Cloudinary 转存、
//      modelUrl 当年改成 idb: 指针，都是为了同一件事。所以客户端必须先把本地图
//      转存成永久 URL 再发上来（app 的 api/uploads），不是在这里再转一次。
//   ② `idb:*` 这类**设备本地指针** —— 只在卡主那台机器上有意义，跟着分享/安装
//      走出去就是死链，而死链不报错，只表现成"参考图那一格是空的"。
//
//   ⚠ 与 modelUrl 的处置**刻意不同**：modelUrl 允许 idb: 入库（那是卡主自己那份
//     记录的一部分），发布/安装时才由 shareableModelUrl() 剥掉。views 则**入库就拒**
//     —— 卡片详情页会把 views 一张张画出来给卡主自己看，存一个连他自己下次换设备
//     都打不开的地址，没有任何一方受益。
//   ⚠ shareableModelUrl 附近那套**第三方版权判断不适用于 views**：views 是 Seedream
//     出的图（我们自己的产物），不是 BOOTH 购入的第三方模型。别顺手套上去。
const VIEW_URL_RE = /^https?:\/\//i;

/** views[].url 能不能发出去 —— 这条规则的唯一实现（zod 与 controller 都调它） */
function isShareableViewUrl(raw) {
  return VIEW_URL_RE.test(String(raw || "").trim());
}

const cardView = z.object({
  url: z
    .string()
    .trim()
    .min(1)
    // 2000 与 modelUrl 同一个数：够长的 CDN 签名 URL 也放得下，但放不下一张 base64
    .max(2000)
    .regex(VIEW_URL_RE, "view url must be an http(s) URL (dataURL / idb: 不收)"),
  kind: z.enum(CARD_VIEW_KINDS).optional().default("detail"),
  // ★ 不给 default：缺省 = 老数据 = 由客户端按 kind 推（理由见 CARD_VIEW_ROLES 的 ★）
  role: z.enum(CARD_VIEW_ROLES).optional(),
  tag: z.string().trim().max(CARD_VIEW_TAG_MAX).optional(),
  note: z.string().trim().max(200).optional().default(""),
});

// 互动 key 的字符集：卡片是客户端 id（mkt_/card_/deck_ 前缀 + 随机串），卡组是 ObjectId 串。
// ★ 收窄不是洁癖：这个值会进 Mongo 查询、也会被当成计数表的主键，放任意字符串
//   等于让调用方随手撑爆索引（120 字符上限同 BranchCard.cardId）。
const assetKey = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/, "invalid asset key");
const assetKind = z.enum(ASSET_KINDS);

// 客户端 Card 形状：{ id, type, name, summary, cover, hot?, tags?, modelUrl?, genPrompt? }
// 兼容传 cardId 的调用方，二选一即可。
const cardItem = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    cardId: z.string().trim().min(1).max(120).optional(),
    type: z.enum(CARD_TYPES).optional().default("prop"),
    name: z.string().trim().max(120).optional().default(""),
    summary: z.string().trim().max(2000).optional().default(""),
    cover: z.string().optional().default(""),
    hot: z.number().int().min(0).max(1e9).optional().default(0),
    tags: z.array(z.string().trim().max(40)).max(12).optional().default([]),
    // ★ 这两个字段 2026-08-11 之前是「发得出、存不下」的：客户端 Card 上有、
    //   卡片详情页把它们当卖点展示（3D 全息 + 生成蓝图），但 schema 没声明 →
    //   z.object strip 掉 → 分享出去的卡是个空壳，且一点错都不报。
    //   modelUrl 允许 idb: 这类设备本地指针入库（那是**卡主自己**那份记录），
    //   但发布/安装时会被 shareableModelUrl() 剥掉——见 controller。
    modelUrl: z.string().trim().max(2000).optional().default(""),
    genPrompt: z.string().trim().max(4000).optional().default(""),
    // ★ 真人声明（客户端圈选提取时用户勾的，肖像同意责任在协议那一步压给了用户）：
    //   真人素材受供应商内容审核与深度合成法规约束，出片档位按它分流。
    //   缺省 = 老客户端/老卡 = 非真人（读侧判否定）——所以**不给 default**，
    //   留 undefined 让 controller 统一按 `=== true` 归一。
    realPerson: z.boolean().optional(),
    // ★ 超过 3 张 / 非 http(s) 一律 **400，不是悄悄截断**：截断的话用户挂了 4 张、
    //   界面上显示 3 张，他只会以为自己少点了一下；而"第 4 张没生效"和
    //   "第 4 张生效了但 AI 没用上"在结果里长得一模一样，查都没法查（铁律八）。
    views: z.array(cardView).max(MAX_CARD_VIEWS).optional().default([]),
  })
  .refine((v) => Boolean(v.id || v.cardId), { message: "card id is required" });

// POST /cards —— 批量加卡（按 { owner, cardId } 幂等）
const addCardsBody = z.object({
  cards: z.array(cardItem).min(1).max(100),
});

// PATCH /cards/:cardId —— 改一张**已有**卡（目前只有 views）。
// ★★ 为什么不能让客户端拿 POST /cards 代替：那条是**新增**语义，控制器用的是
//   `$setOnInsert`（"已存在的字段一个不动"）。拿它去改卡会 201 得漂漂亮亮、库里一个
//   字节都没变，而客户端每次登录都用服务端那份**整体覆盖**本地卡库 —— 用户加的参考图
//   于是在下一次冷启动时无声消失。那是丢数据，不是"暂未同步"。
// ★ views 是**必填**：body 里没有它就 400。可选的话，一个拼错字段名的调用会拿到
//   200 + "改好了"，而库里什么都没发生 —— 同一类静默 no-op，只是换了个地方发生。
const updateCardBody = z.object({
  views: z.array(cardView).max(MAX_CARD_VIEWS),
  // 真人声明可以跟着一起改（可选；不带就保留库里原值——controller 只在拿到布尔时 $set）。
  // ⚠ 当前客户端的 updateCardViews **不发**它（那条 PATCH 是 views 专用），这里声明
  //   是留门：将来真加"改声明"入口时，别再经历一次"发了、被 strip、零报错"。
  realPerson: z.boolean().optional(),
});

const deckName = z.string().trim().max(60);
const deckCardIds = z.array(z.string().trim().min(1).max(120)).max(500);
const assetDescription = z.string().trim().max(200);

// POST /decks —— 建组（name 允许空串，控制器兜底成「未命名卡组」）
const createDeckBody = z.object({
  name: deckName.optional().default(""),
  cardIds: deckCardIds.optional().default([]),
});

// PATCH /decks/:id —— 改名 / 改卡 / 改封面 / 改简介，至少给一个字段。
// ★ coverCardId 与 description 也是「发得出、存不下」的两个：客户端一直在发
//   （卡组详情页的封面卡与简介），schema 没声明就被 strip，于是广场里那行简介永远是空的。
const updateDeckBody = z
  .object({
    name: deckName.min(1).optional(),
    cardIds: deckCardIds.optional(),
    coverCardId: z.string().trim().max(120).optional(),
    description: assetDescription.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.cardIds !== undefined ||
      v.coverCardId !== undefined ||
      v.description !== undefined,
    { message: "name, cardIds, coverCardId or description is required" }
  );

// POST /decks/:id/publish、POST /cards/:cardId/publish —— 简介可省（省了就保留原值）。
// ★ 整个 body 也可省：客户端的分享按钮是 `POST` 不带 body 的，Express 5 下
//   req.body 会是 undefined，没有这个 .default({}) 就会被 zod 判成 400 ——
//   表现是「分享按钮点了没反应」，而按钮本身没有任何毛病。
const publishBody = z
  .object({
    description: assetDescription.optional(),
  })
  .default({});

module.exports = {
  CARD_VIEW_ROLES,
  CARD_VIEW_TAG_MAX,
  addCardsBody,
  updateCardBody,
  createDeckBody,
  updateDeckBody,
  publishBody,
  assetKey,
  assetKind,
  cardView,
  CARD_TYPES,
  ASSET_KINDS,
  ASSET_ACTIONS,
  CARD_VIEW_KINDS,
  MAX_CARD_VIEWS,
  isShareableViewUrl,
};
