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
const { z } = require("../middleware/validate");

// 卡片类型的唯一事实源：models/BranchCard.js 的 enum 也从这里取，
// 客户端对应 app/src/types.ts 的 CARD_TYPES（跨仓，改动要两边一起动）。
const CARD_TYPES = ["character", "scene", "background", "prop", "style"];

// 互动实体的种类与动作，models/BranchAssetStat.js 与 BranchAssetLike.js 的 enum 从这里取
const ASSET_KINDS = ["card", "deck"];
const ASSET_ACTIONS = ["like", "bookmark"];

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
  })
  .refine((v) => Boolean(v.id || v.cardId), { message: "card id is required" });

// POST /cards —— 批量加卡（按 { owner, cardId } 幂等）
const addCardsBody = z.object({
  cards: z.array(cardItem).min(1).max(100),
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
  addCardsBody,
  createDeckBody,
  updateDeckBody,
  publishBody,
  assetKey,
  assetKind,
  CARD_TYPES,
  ASSET_KINDS,
  ASSET_ACTIONS,
};
