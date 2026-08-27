// src/schemas/promptScheme.schemas.js
// 「提示词方案」（人物卡设定图的出图配方）的请求校验。
//
// 一套方案 = 若干个**图位模板**，决定从一张圈选裁剪能炼出哪几张形象图。
// 客户端对应 app/src/data/promptSchemes.ts 的 PromptScheme / SchemeSlot（跨仓，两边一起动）。
//
// ⚠⚠ `z.object` 默认 **strip 未声明字段**。给方案/图位加字段时**四处一起加**：
//   这份 schema、models/PromptScheme.js、controller 的 toSchemePayload、
//   以及 app 仓的 api/schemes.ts。漏任何一处的表现都是「客户端发了、服务端 201 了、
//   读回来是空的，全程零报错」——本仓的 deck / modelUrl / views 都这么丢过。
//   ★ 图位的 `ref` / `size` / `fromCrop` 尤其容易漏：漏了不报错，只是**装回来的方案
//     行为变了**（参考图从脸变成主裁剪、原本不花钱的那格开始花钱），而没有任何一处会说话。
const { z } = require("../middleware/validate");
// ★ role 与 tag 上限**复用卡片那份**：方案图位的 role 就是 CardView.role，
//   两处各写一份枚举的话，方案里能存的 role 会和卡片能存的 role 悄悄分叉。
const { CARD_VIEW_ROLES, CARD_VIEW_TAG_MAX, MAX_CARD_VIEWS } = require("./branchAsset.schemas");

/** 图位的提示词长度上限。★ 比卡片 summary 宽松：方案的价值全在这段话里 */
const SLOT_PROMPT_MAX = 600;
/**
 * 预览示例图：客户端存的是**缩图 dataURL**（约 1KB/张，见 app 的 SCHEME_EXAMPLE_MAX_W）。
 *
 * ★ 这里**允许 dataURL**，与 `views[].url` 只收 http(s) 的规矩**刻意不同**：
 *   views 会被整份塞进卡组快照（一次 GET 返回几十 MB 就是那么来的），而方案示例图
 *   是两张 1KB 的缩图、也不进任何快照。硬门放在**长度**上，不放在协议上。
 * ★ 60000 ≈ 45KB：正常缩图的几十倍余量，但塞不进一张原始卡面。
 */
const EXAMPLE_MAX_LEN = 60000;
const MAX_EXAMPLES = 2;

const schemeSlot = z.object({
  tag: z.string().trim().min(1).max(CARD_VIEW_TAG_MAX),
  role: z.enum(CARD_VIEW_ROLES),
  // 允许空串：`fromCrop` 的格子不调模型，本来就没有提示词
  prompt: z.string().trim().max(SLOT_PROMPT_MAX).optional().default(""),
  ref: z.enum(["body", "face"]).optional(),
  size: z.string().trim().max(20).optional(),
  fromCrop: z.boolean().optional(),
});

/** 客户端 id（app 的 uid("ps") → `ps_xxx`）。字符集收窄同 assetKey：它会进 Mongo 查询 */
const schemeId = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.:-]+$/, "invalid scheme id");

const upsertSchemeBody = z.object({
  schemeId,
  title: z.string().trim().min(1).max(40),
  intro: z.string().trim().max(120).optional().default(""),
  faceless: z.boolean().optional(),
  // ★ 上限与卡片图位同一个数：方案炼出来的图要能存进 views，多的存不下
  slots: z.array(schemeSlot).min(1).max(MAX_CARD_VIEWS),
  examples: z.array(z.string().trim().max(EXAMPLE_MAX_LEN)).max(MAX_EXAMPLES).optional(),
});

const publishBody = z.object({}).optional();

module.exports = {
  schemeId,
  schemeSlot,
  upsertSchemeBody,
  publishBody,
  SLOT_PROMPT_MAX,
  EXAMPLE_MAX_LEN,
  MAX_EXAMPLES,
};
