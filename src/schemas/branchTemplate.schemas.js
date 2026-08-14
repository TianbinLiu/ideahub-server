// src/schemas/branchTemplate.schemas.js
// 白模模板请求校验（zod）。
//
// ⚠⚠ `z.object` 默认 **strip 未声明字段** —— 每个字段都要在这里显式声明，
//   漏一个的表现是「客户端发了、服务端 201 了、读回来是空的，全程零报错」
//   （`deck` 与 `modelUrl` 都这么丢过，见 branchAsset.schemas.js 文件头）。
//   往模板上加字段时四处一起动：这份 schema、models/BranchTemplate.js、
//   routes/branchTemplate.routes.js 的 toTemplatePayload、app 仓的 api/branch.ts。
//
// ★ 这里**刻意没有** refVideo 的 durationSec/width/height/bytes ——
//   不是漏了，是这些数**只由服务端从 Cloudinary 取**（r2v 结算的输入时长就是它，
//   不信客户端报的任何数）。客户端只发 videoUrl 一个字符串，元数据在路由里由
//   服务端按 public_id 向 Cloudinary 要（strip 在这里是帮手：就算客户端塞了也进不来）。
const { z } = require("../middleware/validate");

// coverUrl 只收 https（或空串=暂无封面）。dataURL 一律拒：一张封面几百 KB 的 base64，
// shared 列表一次回包就是几十 MB（BranchDeck.cover 转存 Cloudinary 是同一条教训）。
const HTTPS_RE = /^https:\/\//i;

const recipeBody = z.object({
  styleHint: z.string().trim().max(2000).optional().default(""),
  // 白模模板只有一拍（单节点出片），但形状留成数组与经典配方对齐 ——
  // 老客户端把它当经典配方跑时逐拍读，单元素数组两边都吃得下
  beats: z.array(z.string().trim().max(2000)).max(12).optional().default([]),
  // 经典降级路的镜像时长。[3,15]：下限对齐经典路的 clampDuration 下限，
  // 上限对齐白模上传窗口（refVideo 最长 15s，镜像值不该比本体还长）
  durationSec: z.number().int().min(3).max(15).optional().default(5),
  // app 档位 id。不写 enum：服务端不据此判断任何事，enum 只会让 app 加档位时老服务端 400
  videoTier: z.string().trim().max(40).optional().default(""),
  aspect: z.enum(["portrait", "landscape"]).optional(),
  framePrompt: z.string().trim().max(4000).optional().default(""),
});

// POST /api/branch/templates
const createTemplateBody = z.object({
  title: z.string().trim().min(1).max(120),
  intro: z.string().trim().max(2000).optional().default(""),
  coverUrl: z
    .string()
    .trim()
    .max(2000)
    .regex(HTTPS_RE, "coverUrl must be an https URL (dataURL 不收)")
    .or(z.literal(""))
    .optional()
    .default(""),
  recipe: recipeBody,
  // 白模视频地址：必须是**本账号刚传的** Cloudinary 地址，三重白名单在路由里校
  // （host + 目录 + public_id 归属），这里只把形状收住
  videoUrl: z.string().trim().min(1).max(2000).regex(HTTPS_RE, "videoUrl must be an https URL"),
});

module.exports = { createTemplateBody, HTTPS_RE };
