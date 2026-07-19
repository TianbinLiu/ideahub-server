// src/schemas/arenaComment.schemas.js
// 情景 / 人格 详情页讨论区的请求校验（POST /:id/comments）
const { z } = require("../middleware/validate");

const createBody = z.object({
  content: z.string().trim().min(1).max(2000),
  imageUrl: z.string().trim().max(500).optional().default(""),
  // 顶楼回复时不传 / 传 null；楼中楼传其顶楼的评论 id。
  // 合法性（是否属于同一 target、是否只有一层）由控制器判定，见 arenaComment.controller.js
  parentId: z.string().trim().optional().nullable(),
});

module.exports = { createBody };
