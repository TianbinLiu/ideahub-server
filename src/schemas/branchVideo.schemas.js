// src/schemas/branchVideo.schemas.js
// 分支视频请求校验（zod v4）。
// ★ listQuery 不走 validate({ query })：Express 5 的 req.query 是只读 getter，
//   validate 里的 `req.query = ...` 会静默失效，所以列表 query 在 controller 里显式 parse。
const { z } = require("../middleware/validate");

// 帧/视频字段可能是超长 dataURL（Seedream 出图的 base64），不设 max
const assetUrl = z.string().max(12_000_000).optional().default("");

const segmentBody = z.object({
  title: z.string().trim().max(200).optional().default(""),
  plot: z.string().trim().max(8000).optional().default(""),
  firstFrame: assetUrl,
  lastFrame: assetUrl,
  durationSec: z.coerce.number().min(0).max(3600).optional().default(0),
  videoUrl: assetUrl,
});

const choiceBody = z.object({
  label: z.string().trim().max(200).optional().default(""),
  nextId: z.string().trim().max(120),
});

const branchNodeBody = z.object({
  id: z.string().trim().min(1).max(120),
  segment: segmentBody,
  choices: z.array(choiceBody).max(12).optional().default([]),
});

const branchTreeBody = z.object({
  rootId: z.string().trim().min(1).max(120),
  startChoices: z.array(choiceBody).max(12).optional(),
  // zod v4 的 z.record 必须显式给 key 类型
  nodes: z.record(z.string().min(1).max(120), branchNodeBody),
});

// 随作品发布的卡组快照（app 的 VideoDeck）。
// ★ id 字段客户端叫 `id`（本地 Card.id），落库统一叫 `cardId`（与 BranchCard 一致）；
//   两个名字都收，映射在 controller 里做一次。
const deckCardBody = z
  .object({
    id: z.string().trim().max(120).optional(),
    cardId: z.string().trim().max(120).optional(),
    type: z.string().trim().max(40).optional().default("prop"),
    name: z.string().trim().max(120).optional().default(""),
    summary: z.string().trim().max(2000).optional().default(""),
    cover: assetUrl,
    tags: z.array(z.string().trim().max(40)).max(20).optional().default([]),
  })
  .loose(); // 卡上还有 modelUrl/genPrompt 等本地字段，收下但不入库

const deckBody = z.object({
  name: z.string().trim().max(120).optional().default(""),
  cards: z.array(deckCardBody).max(60).optional().default([]),
});

const visibility = z.enum(["public", "private"]);

// POST /api/branch/videos —— DraftVideo
const publishBody = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().max(40).optional().default(""),
  description: z.string().trim().max(4000).optional().default(""),
  cover: assetUrl,
  segments: z.array(segmentBody).min(1).max(60),
  branchTree: branchTreeBody.optional(),
  // ★ 这两个字段**必须显式声明**：z.object 默认 strip 未声明字段，
  //   deck 之前就是因为没写这行被静默丢掉的——客户端发了、服务端存了个空。
  deck: deckBody.optional(),
  visibility: visibility.optional().default("public"),
  // 幂等键（客户端生成，重试沿用）。z.object 默认 strip 未声明字段，不写这行就到不了 controller
  clientId: z.string().trim().min(1).max(120).optional(),
});

// PATCH /api/branch/videos/:id —— 作品编辑（仅作者）
// ★ 全部 optional，且**不给 default**：给了 default 的字段会凭空出现在 patch 里，
//   于是「只改可见性」的请求会顺手把标题清成空串。
const updateBody = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().max(40).optional(),
    description: z.string().trim().max(4000).optional(),
    visibility: visibility.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

// POST /api/branch/videos/:id/comments
const commentBody = z.object({
  text: z.string().trim().min(1).max(1000),
});

// GET /api/branch/videos —— 列表 query
const listQuery = z
  .object({
    feed: z.enum(["recommend", "following"]).optional().default("recommend"),
    category: z.string().trim().max(40).optional().default(""),
    q: z.string().trim().max(120).optional().default(""),
    // cursor 形如 "<ISO时间>_<ObjectId>"，由上一页 nextCursor 原样回传
    cursor: z.string().trim().max(80).optional().default(""),
    limit: z.coerce.number().int().min(1).max(50).default(12),
  })
  .loose(); // 允许客户端带无关 query（如 _t 防缓存）

// GET /api/branch/videos/:id/comments
const commentListQuery = z
  .object({
    cursor: z.string().trim().max(80).optional().default(""),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .loose();

module.exports = {
  publishBody,
  updateBody,
  commentBody,
  listQuery,
  commentListQuery,
  segmentBody,
  branchTreeBody,
  deckBody,
};
