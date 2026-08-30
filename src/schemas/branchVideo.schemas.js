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
  // ★ 作品的话题标签。**必须显式声明**，理由同下面 deck/pricing 那条 ★：
  //   z.object 默认 strip 未声明字段 —— 客户端发了、这里 201 了、读回来永远是空的。
  //   上限与 deckCardBody.tags 取同一组数（20 个 × 40 字），客户端也用同一组常量。
  tags: z.array(z.string().trim().max(40)).max(20).optional().default([]),
  cover: assetUrl,
  segments: z.array(segmentBody).min(1).max(60),
  branchTree: branchTreeBody.optional(),
  // ★ 这两个字段**必须显式声明**：z.object 默认 strip 未声明字段，
  //   deck 之前就是因为没写这行被静默丢掉的——客户端发了、服务端存了个空。
  deck: deckBody.optional(),
  visibility: visibility.optional().default("public"),
  // 「只有拿到链接的人能看」。★ 与 visibility 一起构成三档：
  //   public / private+linkOnly（凭链接可见）/ private。见 model 里那条 ★★（为什么不加枚举值）
  linkOnly: z.boolean().optional(),
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
    // 标签可改（属于"壳"，与标题/简介/分区同类）。★ 不给 default：见本对象顶部那条 ★
    tags: z.array(z.string().trim().max(40)).max(20).optional(),
    visibility: visibility.optional(),
    // ★ 老客户端**不发**这个键 ⇒ $set 碰不到它 ⇒ 它们的编辑不会把"凭链接可见"改掉。
    //   这正是把它做成独立字段（而不是 visibility 的第三个枚举值）想要的效果。
    linkOnly: z.boolean().optional(),
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

/** 评论正文上限。★ span 的 offset/length 都被正文长度天然约束住，所以两处同一个数（铁律六）。 */
const MAX_COMMENT_LEN = 1000;

/**
 * 客户端补全面板报上来的一段提及。
 *
 * ★★ 这里收客户端的名单，但**不盲信**它 —— 差别全在 controller 调的
 *   `parseMentionsWithSpans`：它逐条核对
 *   `text.slice(offset, offset+1+length) === '@' + 该用户当下的名字`，
 *   核不过就丢掉这一条（不是整条评论 400）。所以伪造不出一个正文里根本没出现的提及。
 *   ⚠ 只声明形状**不等于**安全：把下面的核对去掉，这个字段立刻退化成
 *     "给任意用户发推送"的接口（正文里一个 @ 都没有也能点名一百个人）。
 *
 * ★ 为什么需要它：中日韩没有词边界，`@我是王桑你看看这个` 用正则切不出「我是王桑」。
 *   而选人本来就是在补全面板里完成的，面板知道用户选了谁 —— 让它把范围报上来，
 *   比在服务端猜靠谱得多。ASCII 的 `@username` 自动解析仍然保留（手打 / 老客户端）。
 *
 * ★ offset/length 的单位是 **UTF-16 码元**（JS 字符串下标），两端都是 JS，天然同口径。
 */
const mentionSpanBody = z.object({
  userId: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "userId must be a 24-hex ObjectId"),
  // 正文里那个 `@` 的下标
  offset: z.coerce.number().int().min(0).max(MAX_COMMENT_LEN),
  // 名字的长度（不含 `@`）
  length: z.coerce.number().int().min(1).max(MAX_COMMENT_LEN),
});

// POST /api/branch/videos/:id/comments
const commentBody = z.object({
  text: z.string().trim().min(1).max(MAX_COMMENT_LEN),
  // 楼中楼：被回复的那条**顶层**评论的 _id。
  // ★ 必须显式声明：z.object 默认 strip 未声明字段，漏了这一行的表现是
  //   「每一条回复都静默变成顶层评论」—— 客户端发了 parentId、服务端 201 了、
  //   读回来是一条挂在评论区最外层的孤儿。deck / pricing 已经栽过两次同一个坑。
  //   24 位十六进制是 ObjectId 的长度，非法值在 controller 里再判一次 400。
  parentId: z.string().trim().length(24).optional(),
  // ★ 可选：老版本 App 不发这个字段，那时只有 ASCII 自动解析这条路（行为与从前一模一样）。
  //   上限 20 与 mentionParser 的 MAX_MENTION_CANDIDATES 同源：挡的是数据库开销
  //   （一条报 500 个 span 的评论会变成一个 500 元素的 $in）。真正生效的上限是
  //   合并后的 MAX_RESOLVED_MENTIONS（10），在 mentionParser 里。
  mentions: z.array(mentionSpanBody).max(20).optional(),
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
    // ★ 按作者筛（用户 id）。没有它，app 点开一个陌生人就只能画一个凭空空着的主页 ——
    //   界面上看不出是"这个人没发过作品"还是"我们根本没去查"。
    //   这里只管形状（24 位十六进制 = ObjectId），合法性在 controller 里再判一次：
    //   不判的话 Mongo 会把 CastError 抛成 500，而这是个用户输入错误，该是 400。
    //   ⚠ 它**不是**可见性的替代品：拿到别人的 id 也只能看到对方的公开作品，
    //     私密作品由 visibilityFilter 那一条挡（见 controller 里的 $and 拼法）。
    author: z.string().trim().max(64).optional().default(""),
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
  mentionSpanBody,
  DANMAKU_MAX_LEN,
  MAX_COMMENT_LEN,
};
