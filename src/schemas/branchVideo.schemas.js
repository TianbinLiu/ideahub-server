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
  // ★ 画幅与档位：客户端（app 的 VideoSegment）一直在发这两个字段，但这里没声明，
  //   于是被 z.object 默默 strip 掉 —— 客户端发了、服务端 201 了、读回来没有，全程零报错。
  //   `deck` 也是这么丢的，同一个坑第二次。给 DraftVideo 加字段就必须同步这份 schema。
  //   aspect 丢了的后果：首页在首帧解码出来之前按错的比例排版（横片被当竖片铺满裁掉两边），
  //   解码完才跳回正确比例，看起来就是"闪一下"。播放端最终以真实解码尺寸为准，所以不致命，
  //   但没有理由让它丢。videoTier 丢了则是回看时不知道这段当初用的哪档，对不上账。
  videoTier: z.string().trim().max(80).optional(),
  aspect: z.enum(["portrait", "landscape"]).optional(),
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

// 作品付费设置（app 的 VideoPricing）。★ 同样是"发得出、存不下"过的字段：
// 没声明就被 z.object strip 掉，作者在发布页设了价、看到"你到手 3500"，
// 发布后重启一看变成免费——收益永远是 0，而且全程零报错。
const pricingBody = z.object({
  mode: z.enum(["free", "paid"]),
  partPrices: z.array(z.coerce.number().int().min(0).max(10_000_000)).max(60).optional().default([]),
});

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
  pricing: pricingBody.optional(),
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
    // 封面可改（成片不可改，但"用哪一帧当封面"属于壳）。
    // ★ 只收 http(s) URL，**不收 dataURL**：客户端先把它传成永久 URL 再 PATCH
    //   （app 的 EditPage 走 publishAssets.imageToUrl，与发布路径同一条）。
    //   收 dataURL 的话请求体是 MB 级的，会撞上网关 1MB 的 client_max_body_size，
    //   而且撞了只表现成 fetch failed，看不出是因为太大。
    //   ⚠ 不能用 z.url()：`data:image/...;base64,xxx` 也是**合法 URI**，zod 会放行
    //     （用例实测：期望 400，实得 200）。必须显式钉住 http/https 协议。
    cover: z
      .string()
      .trim()
      .max(2000)
      .regex(/^https?:\/\//i, "cover must be an http(s) URL")
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

// POST /api/branch/videos/:id/comments
const commentBody = z.object({
  text: z.string().trim().min(1).max(1000),
});

/** 一条弹幕的字数上限。★ 这是**契约值**（docs/api-contract.md「弹幕」），
 *  客户端的 DANMAKU_MAX_LEN 必须与它相等 —— 客户端松了会收到一串 400，
 *  客户端紧了则是"服务端明明收得下，用户却打不完一句话"。 */
const DANMAKU_MAX_LEN = 40;

// POST /api/branch/videos/:id/danmaku
const danmakuBody = z.object({
  text: z.string().trim().min(1).max(DANMAKU_MAX_LEN),
  // 全片累计秒。上限 86400（一天）纯粹是防呆：作品再长也不可能到这个量级，
  // 但不设上限的话一个 1e300 就能让播放端的轨道调度算出 Infinity
  at: z.coerce.number().min(0).max(86400),
  // ★ 必须钉成 #rrggbb 再入库。这个值最后会原样进客户端的 style.color ——
  //   收任意字符串等于把一段用户可控的文本喂进 CSS。空串 = 用默认色
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-f]{6}$/i, "color must be #rrggbb")
    .optional(),
});

// GET /api/branch/videos/:id/danmaku
const danmakuListQuery = z
  .object({
    // 播放端要的是**一整条时间轴**，不是一页 —— 所以这里不做 cursor 分页，
    // 只给一个"最多取多少条"的天花板（采样口径见 controller）
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .loose();

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
  danmakuBody,
  listQuery,
  commentListQuery,
  danmakuListQuery,
  segmentBody,
  branchTreeBody,
  deckBody,
  DANMAKU_MAX_LEN,
};
