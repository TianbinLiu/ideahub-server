// src/schemas/branchAsset.schemas.js
// 分支视频 · 卡片/卡组请求校验（zod）。
// 注意 cover 可能是 Seedream 出图的 dataURL（很长），这里【不】限制长度，
// 由控制器转存成 Cloudinary URL；校验只保证类型正确。
const { z } = require("../middleware/validate");

// 卡片类型的唯一事实源：models/BranchCard.js 的 enum 也从这里取，
// 客户端对应 app/src/types.ts 的 CARD_TYPES（跨仓，改动要两边一起动）。
const CARD_TYPES = ["character", "scene", "background", "prop", "style"];

// 客户端 Card 形状：{ id, type, name, summary, cover, hot?, tags? }
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
  })
  .refine((v) => Boolean(v.id || v.cardId), { message: "card id is required" });

// POST /cards —— 批量加卡（按 { owner, cardId } 幂等）
const addCardsBody = z.object({
  cards: z.array(cardItem).min(1).max(100),
});

const deckName = z.string().trim().max(60);
const deckCardIds = z.array(z.string().trim().min(1).max(120)).max(500);

// POST /decks —— 建组（name 允许空串，控制器兜底成「未命名卡组」）
const createDeckBody = z.object({
  name: deckName.optional().default(""),
  cardIds: deckCardIds.optional().default([]),
});

// PATCH /decks/:id —— 改名 / 改卡，至少给一个字段
const updateDeckBody = z
  .object({
    name: deckName.min(1).optional(),
    cardIds: deckCardIds.optional(),
  })
  .refine((v) => v.name !== undefined || v.cardIds !== undefined, {
    message: "name or cardIds is required",
  });

module.exports = { addCardsBody, createDeckBody, updateDeckBody, CARD_TYPES };
