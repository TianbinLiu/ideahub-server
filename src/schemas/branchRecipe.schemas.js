// src/schemas/branchRecipe.schemas.js
// 公开配方（制作过程）请求校验（zod v4）。见 models/BranchRecipe.js 的文件头。
//
// ★★ 这份 schema 就是**白名单本身**：配方会公开给所有人，所以与 branchProject.schemas（画布：Mixed、
//   服务端不解释内容）正相反 —— 这里**逐个字段声明**，z.object 把没声明的键剥掉，controller 存的是
//   解析之后的那份。客户端的投影（app 仓 data/recipe.ts）是第一道，这里是第二道：
//   哪天客户端把不该公开的东西投了进来（没选中的方案、圈选标注、原话草稿），它到这里也落不了库。
// ★ 形状与 app 仓 `data/recipe.ts` 的 WorkflowRecipe **逐字段相等**（跨仓契约，docs/api-contract.md「公开配方」）。
//   给配方加字段：这里、app 的投影、app 的类型三处一起动；只加一边的表现是"发了、200 了、读回来没有"。
const { z } = require("../middleware/validate");
const { cardView, startFrames, CARD_TYPES, MAX_CARD_VIEWS, TEXT_DESC_MAX } = require("./branchAsset.schemas");
const { NO_LOCAL } = require("./branchProject.schemas");

/** 一份配方最多几段。与发布体 segments 的上限（60）不是一回事：这是流水线的段数，剪辑页最多也只排 24 段 */
const RECIPE_MAX_NODES = 24;
/** 随配方带走的卡（去重后）最多几张。与作品卡组快照同一个数 */
const RECIPE_MAX_CARDS = 60;
/** 「要使用者自己填的位子」最多几个 */
const RECIPE_MAX_SLOTS = 30;
/**
 * 整份配方的字节上限（`JSON.stringify`）。
 * ★ 估的，不是量的：24 段 × 剧本上限 8KB ≈ 192KB，60 张卡 × 约 1.5KB ≈ 90KB，其余是零头 —— 512KB 留了约一倍。
 *   典型的 5 段配方在 10~30KB。上线后按 BranchRecipe.bytes 的真实分布再调。
 */
const RECIPE_MAX_BYTES = 512 * 1024;

/** 只收 http(s)（或空串）：配方里出现的每一个地址都是给**别人**的设备去取的，本机地址对别人就是死链 */
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\//i, "must be an http(s) URL");
const httpUrlOrEmpty = z
  .string()
  .trim()
  .max(2000)
  .regex(/^(https?:\/\/.*)?$/i, "must be an http(s) URL or empty")
  .optional()
  .default("");

/** 镜头字段（app 的 types.ShotSpec）：景别 / 运镜 / 情绪节拍 */
const shot = z.object({
  size: z.string().trim().max(40).optional(),
  camera: z.string().trim().max(40).optional(),
  beat: z.string().trim().max(200).optional(),
});

/**
 * 随配方带走的一张卡。字段与作品卡组快照（models/BranchVideo.deckCardSchema）同一批 ——
 * `modelUrl` / `genPrompt` 是卡主私有的，那边不入快照，这里同样不收。
 *
 * ★★ `realPerson` **声明了、但只许是 false**：真人卡不许出现在公开配方里（它的形象图是一个真实的人的照片，
 *   卡片本身也不许上广场）。不声明的话 z.object 会把这一位悄悄剥掉、把卡留下 —— 那正好是最坏的结局
 *   （照片公开了，"这是真人"的标记没了）。声明成只许 false，带着 true 来的整发 400。
 *   controller 另按作者自己的卡库再核一遍（见 assertShareableCards）。
 */
const recipeCard = z.object({
  cardId: z.string().trim().min(1).max(120),
  type: z.enum(CARD_TYPES),
  name: z.string().trim().max(120).optional().default(""),
  summary: z.string().trim().max(2000).optional().default(""),
  cover: httpUrlOrEmpty,
  tags: z.array(z.string().trim().max(40)).max(12).optional().default([]),
  idLine: z.string().trim().max(200).optional().default(""),
  textDesc: z.string().trim().max(TEXT_DESC_MAX).optional().default(""),
  startFrames: startFrames.optional(),
  views: z.array(cardView).max(MAX_CARD_VIEWS).optional().default([]),
  realPerson: z.literal(false).optional(),
});

/**
 * 「要使用者自己填的位子」：原作在这儿用了一张**不能随配方带走**的卡。
 *   real    —— 真人卡。连名字都不带（那是一个真实的人）
 *   foreign —— 从别人那儿装来的卡（转发件不许再分享）。带名字，方便使用者自己去广场找
 *   private —— 作者没随配方带上的卡（卡面取不到永久地址等）。带名字
 */
const recipeSlot = z
  .object({
    type: z.enum(CARD_TYPES),
    why: z.enum(["real", "foreign", "private"]),
    name: z.string().trim().max(120).optional().default(""),
  })
  // 真人位子的名字服务端再抹一遍：客户端投影本来就不该带，这里不信它
  .transform((s) => (s.why === "real" ? { ...s, name: "" } : s));

/** 这一段用的段模板：**只回指、不带快照** —— 复制时现去取这条模板（取不到 = 已下架 / 已删，那一段退成普通段）。
 *  ★ 为什么不带快照：出片时服务端只认**已登记**的模板视频地址（ark.routes 的 resolveR2v），
 *    快照里的地址一旦对应的模板没了，带过去也出不了片，还会让人以为"这一段是好的"。 */
const recipeTpl = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{24}$/i, "tpl.id must be a 24-hex ObjectId"),
  title: z.string().trim().max(120).optional().default(""),
  /** 分段模板组里的第几段（从 0 起）/ 一共几段 */
  part: z
    .object({ index: z.coerce.number().int().min(0).max(23), count: z.coerce.number().int().min(1).max(24) })
    .optional(),
});

/** 原作这一段还用过、但**没有随配方带走**的东西（只给故事板说一句，不带内容） */
const RECIPE_NODE_FLAGS = ["ref-video", "mid-frames", "stage", "anns", "revised"];

const recipeNode = z.object({
  title: z.string().trim().max(200).optional().default(""),
  plot: z.string().trim().max(8000).optional().default(""),
  shot: shot.optional(),
  durationSec: z.coerce.number().min(1).max(60),
  /** 档位 id（app 的 VIDEO_TIERS）与当时真正发出去的模型 id（事实，档位底下的模型会换代） */
  tier: z.string().trim().min(1).max(80),
  model: z.string().trim().max(80).optional(),
  aspect: z.enum(["portrait", "landscape"]),
  /** 起拍承接上一段的真实尾帧 */
  chain: z.boolean().optional().default(false),
  /** 生成模式：经典（推演方案 → 出片）/ 白模复刻（段模板）/ 自定义直出 */
  kind: z.enum(["classic", "blockout", "custom"]),
  /** 这一段挂了哪几张卡（指向 deck 里的 cardId）与哪几个空位（指向 cast 的下标） */
  cards: z.array(z.string().trim().min(1).max(120)).max(30).optional().default([]),
  slots: z.array(z.coerce.number().int().min(0).max(RECIPE_MAX_SLOTS - 1)).max(RECIPE_MAX_SLOTS).optional().default([]),
  tpl: recipeTpl.optional(),
  flags: z.array(z.enum(RECIPE_NODE_FLAGS)).max(RECIPE_NODE_FLAGS.length).optional().default([]),
  /** 起止画面：**只给人看**（故事板），复制时不带进流水线 */
  preview: z.object({ first: httpUrl.optional(), last: httpUrl.optional() }).optional(),
});

const recipe = z
  .object({
    v: z.literal(1),
    mode: z.enum(["workflow", "simple"]),
    nodes: z.array(recipeNode).min(1).max(RECIPE_MAX_NODES),
    deck: z.array(recipeCard).max(RECIPE_MAX_CARDS).optional().default([]),
    cast: z.array(recipeSlot).max(RECIPE_MAX_SLOTS).optional().default([]),
  })
  // 引用完整：段里点到的卡 / 空位都得真的在这份配方里。悬空引用到了别人手上是"这一段挂了一张不存在的卡"
  .refine(
    (r) => {
      const ids = new Set(r.deck.map((c) => c.cardId));
      return r.nodes.every((n) => n.cards.every((id) => ids.has(id)) && n.slots.every((i) => i < r.cast.length));
    },
    { message: "配方里有一段引用了不在这份配方里的卡或空位" }
  )
  .refine((r) => new Set(r.deck.map((c) => c.cardId)).size === r.deck.length, { message: "配方里的卡有重复" });

/** PUT /api/branch/videos/:id/recipe */
const recipeBody = z
  .object({
    recipe,
    // 这份配方描述的是作品的哪一版（必填，理由同工坊工程：对不上就是拿上一版的制作过程冒充这一版）
    videoRevision: z.coerce.number().int().min(0).max(100000),
    public: z.boolean().optional().default(true),
    // 发布页「同时上架到模板市场」：与 public 同一拍落（listed 只在 public 为真时生效，controller 把关）
    listed: z.boolean().optional().default(false),
  })
  .refine((v) => !NO_LOCAL.test(JSON.stringify(v.recipe)), {
    message: "配方里还有本机地址（dataURL / idb: / 方舟临时链接），不能公开",
  })
  .refine((v) => Buffer.byteLength(JSON.stringify(v.recipe)) <= RECIPE_MAX_BYTES, {
    message: "这份制作过程太大了",
  });

/** PATCH /api/branch/videos/:id/recipe —— 开关公开 / 上架到模板市场，不换正文（至少给一样） */
const recipePatchBody = z
  .object({ public: z.boolean().optional(), listed: z.boolean().optional() })
  .refine((v) => v.public !== undefined || v.listed !== undefined, { message: "至少要给 public 或 listed 一样" });

module.exports = {
  recipeBody,
  recipePatchBody,
  recipe,
  RECIPE_MAX_NODES,
  RECIPE_MAX_CARDS,
  RECIPE_MAX_SLOTS,
  RECIPE_MAX_BYTES,
  RECIPE_NODE_FLAGS,
};
