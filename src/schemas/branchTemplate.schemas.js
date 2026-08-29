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
//
// ★★ 白模 V2 的 `roles` / `source` **同样刻意不在这里声明**，理由与 refVideo 逐字相同：
//   两者都由服务端在白模化那一步自己写（roles 来自 chat vision 的清单，source 是服务端
//   拼变换 URL 时用的那四组数）。收客户端报的 roles = 让用户自己写"1 号位是谁"，
//   而那份描述正是套用者挂卡时的唯一依据；收客户端报的 source = 让用户自己标价
//   （durSec 就是 r2v 的计价输入时长）。**这里 strip 是帮手，不是漏洞** ——
//   文件头那条"每个字段都要显式声明"针对的是**我们想收的**字段，别把两件事混了。
//   ⚠ 唯一的例外在文件末尾的 `patchRolesBody`：**作者对标记的确认**是收的
//   （那是只有人做得出来的输入，且碰不到钱）。两条别混：建模板/白模化那两条路
//   一律不收 roles，收了就等于让提交方自己写"从左数第3个是谁"。
//
// ★★ `markSlots`（标记方案位）**三条 body 一律刻意不收**，与 roles/source 同一条理由，
//   而 `patchRolesBody` 那条尤其要害：**让作者改得动方案位 = 让他把一个序数模板标成
//   编号模板**，套用侧当场整份错（输入框里冒出 `编号从左数第3个=凛`），且零报错。
//   这一位记的是"当初那段视频上究竟做出了哪几个位置"——是历史事实，不是作者的意见，
//   只由服务端在白模化那一步自己写（谁发的提示词，谁记这个模板是什么方案）。
//   z.object 默认 strip，在这里**是帮手**：客户端塞了也进不来。
const { z } = require("../middleware/validate");
// ★ 「最多看几帧」这个数**只有 services/blockoutize.service 一处**（铁律六）：
//   下面 frameTimes 的数组上限从那里 import，不在这儿抄一个 8。
//   抄一份的表现是改上限时改一处漏一处，而两处都不报错 —— 只会变成
//   "schema 放进来 10 个、真正抽帧只看 8 个、报价按 10 个算"（CLAUDE.md「上限自己抄一份」坑）。
// ★ 「最多几个角色位」同理只有那一处（BLOCKOUT_ROLE_MAX）：这里抄一个 9 的话，
//   改上限时改一处漏一处**没有任何症状** —— 只会变成"白模化只登记 9 格、作者却能
//   核对成 12 格"，多出来那几格挂上的卡在出片时因为参考图预算超了被悄悄丢掉，钱照扣。
const { VISION_FRAMES_MAX, BLOCKOUT_ROLE_MAX } = require("../services/blockoutize.service");

// coverUrl 只收 https（或空串=暂无封面）。dataURL 一律拒：一张封面几百 KB 的 base64，
// shared 列表一次回包就是几十 MB（BranchDeck.cover 转存 Cloudinary 是同一条教训）。
const HTTPS_RE = /^https:\/\//i;

const recipeBody = z.object({
  styleHint: z.string().trim().max(2000).optional().default(""),
  // 白模模板只有一拍（单节点出片），但形状留成数组与经典配方对齐 ——
  // 老客户端把它当经典配方跑时逐拍读，单元素数组两边都吃得下
  beats: z.array(z.string().trim().max(2000)).max(12).optional().default([]),
  // 经典降级路的镜像时长。[3,30]：下限对齐经典路的 clampDuration 下限，
  // 上限对齐**参考视频**窗口（TEMPLATE_REF_RULES.maxSec = 30，镜像值不该比本体还长）。
  // ★ 2026-08-15 从 15 放宽到 30：白模 V2 的那一段由编辑页框选，方舟 edit 的时长窗口
  //   本来就是 [4,30]（F1 实测）。老客户端只发得出 ≤15 的值，放宽对它们零影响。
  durationSec: z.number().int().min(3).max(30).optional().default(5),
  // app 档位 id。不写 enum：服务端不据此判断任何事，enum 只会让 app 加档位时老服务端 400
  videoTier: z.string().trim().max(40).optional().default(""),
  aspect: z.enum(["portrait", "landscape"]).optional(),
  framePrompt: z.string().trim().max(4000).optional().default(""),
});

// POST /api/branch/templates
const createTemplateBody = z.object({
  /**
   * 长视频分段点（秒，升序，相对视频起点）。缺省/空 = 整段登记一个模板（老行为原样）。
   * 有值 = 服务端把源视频**物理切成 N 段独立资产**各自登记（每段一个普通模板，group 归组）
   * —— 切成独立资产而不是子片段 URL，是为了让识别/挂卡/出片对"段"零特殊分支。
   * 每段都必须落在方舟 edit 的 [4,30] 窗口里：越界**整单 400**，服务端只验不修 ——
   * 替用户挪分段点 = 替他改了每段的价钱（客户端负责把用户标的帧规划成合法分段）。
   */
  splits: z.array(z.number().min(0.5).max(600)).max(11).optional(),
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

// ── POST /api/branch/templates/blockoutize（白模 V2）──────────────────
//
// 客户端在编辑页框选出「哪一段 + 画面哪一块」，提交的是**四组数**，不是 URL：
// 变换地址由服务端自己拼（utils/templateVideoAsset.buildClipUrl）。
// ★ 为什么不收 URL：URL 里的 `du_` 就是 r2v 的计价输入时长，收 URL = 让用户自己标价。
//
// ★ 上下界只收「形状上不可能对」的那一档（非负整数、别把服务器撑爆），
//   **真正的验收（F1 时长 [4,30]、F3 像素/边长/比例、裁剪框在原片内）在路由里**，
//   与建模板复核共用 middleware/upload.js 的那一份窗口 —— 窗口只能有一处实现（铁律六），
//   在 zod 里再写一遍数字就是第二处，改窗口时必漏。
const cropBody = z.object({
  x: z.number().int().min(0).max(20000),
  y: z.number().int().min(0).max(20000),
  w: z.number().int().min(1).max(20000),
  h: z.number().int().min(1).max(20000),
});

const blockoutizeBody = z.object({
  // 本账号刚传的原始素材（`ideahub/template-videos/<userId>-<ts>`）。归属在路由里校
  publicId: z.string().trim().min(1).max(300),
  startSec: z.number().int().min(0).max(600),
  durSec: z.number().int().min(1).max(600),
  crop: cropBody,
  // 模板的展示信息（与 createTemplateBody 同口径：coverUrl 只收 https 或空串）
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
  // app 档位 id / 画幅：只进 recipe 当展示镜像，服务端不据此做任何判断
  // （白模化那一发的模型由服务端定死，见 routes/branchTemplate.routes 的 BLOCKOUT_MODEL）
  videoTier: z.string().trim().max(40).optional().default(""),
  aspect: z.enum(["portrait", "landscape"]).optional(),
  // 作者对画面的补充说明（"这段里的人都穿古装"之类），拼进白模化提示词。
  // 不是必填：F4 的要害是**服务端自己先看一眼再点名**，不是让用户描述
  note: z.string().trim().max(500).optional().default(""),
  /**
   * 用户在编辑页自己标的「AI 看哪几帧」，**相对选段起点**的秒数（0 = 这一段的第一帧）。
   *
   * ★★ 必须在这里**显式声明**，否则 zod 的 `z.object` 默认 strip ——
   *   表现是"客户端发了、服务端 202 了、AI 照样只看自动那几帧"，全程零报错（文件头那条坑）。
   * ★ 缺省（不传 / 空数组）= **自动模式**：帧数按时长算（每 1.5 秒一帧，下限 3 上限 8），
   *   规则的唯一实现在 services/blockoutize.visionFrameTimes。自选模式是给
   *   **"画面里人数会变"的素材**用的：用户看得见哪里入场哪里离场，就在变化前后各标一帧。
   * ★ 这里只收"形状上不可能对"的那一档（非负有限数、别把服务器撑爆、不超上限）。
   *   **真正的验收在 `visionFrameTimes` 里再做一遍**（越界丢弃、去重、排序、截断）——
   *   不是重复，是因为那一份才是报价与抽帧共同的锚点，而 zod 只管得到这一个请求。
   * ★ 上界 600 与 `startSec`/`durSec` 同口径（上传窗口最长 600s），不是又一处窗口。
   *   zod 4 的 `z.number()` 已经拒 NaN/Infinity，所以"有限数"这条不用再写一遍。
   */
  frameTimes: z.array(z.number().min(0).max(600)).max(VISION_FRAMES_MAX).optional(),
});

// ── POST /api/branch/templates/blockoutize/finish（取回结果，白模 V2 第二阶段）──
//
// ★★ 这条 body **只有一个 jobId**，这是刻意的、也是两阶段最容易被做错的地方：
//   建模板需要的一切（publicId / startSec / durSec / crop / roles / title / intro /
//   coverUrl / videoTier / aspect）在阶段一就**全部落进取件凭据**了（models/BlockoutJob），
//   finish 一个字都不再收。收了就等于给了客户端一次"改价改内容"的机会 ——
//   `durSec` 是 r2v 的计价输入时长（开炼时按 4 秒报的价、取件时报 30 秒），
//   `roles` 是套用者挂卡的唯一依据（开炼时 AI 认出的人、取件时换成别人）。
//   两者都不会报错，只会在账目和别人的作品里静默出事。
// ★ 连"任务成功了没有"也不收：finish **自己向方舟核实**（services/blockoutize.fetchTaskState），
//   与试炼闸 provenAt 同一条理由 —— 服务端两头自己看见才算数。
// ★ 归属同样不在这里：只认凭据自己的 ownerId（路由里判），别人拿到 jobId 也取不走。
const finishBlockoutizeBody = z.object({
  // ObjectId 的十六进制形状。真正的合法性由路由的 isValidObjectId 判（唯一实现），
  // 这里只把长度收住，别让一条 2KB 的字符串进到 Mongo 查询里
  jobId: z.string().trim().min(1).max(64),
});

// ── PATCH /api/branch/templates/:id/roles（编号由作者确认）──────────────
//
// ★★ 上面刚说过「roles 由服务端写、客户端提交一律不收」，这里却收 —— 不矛盾，
//   因为这一发提交的东西**只有人做得出来**：作者把成片放出来，对着画面从左往右数
//   （老模板是看人偶头上的数字），把真实的那个标记抄进对应的角色位。
//   落库那份 label 是服务端按视觉那一步的清单编的**猜测**，
//   而 F5 实测编号稳定但**不连续**（实出 1/2/4/5）—— 猜错的后果是套用者把卡挂到
//   别人身上，钱照扣、零报错。所以这条路收的不是"数据"，是**作者的确认**。
// ★ 它收得起的前提是这份输入**碰不到钱**：refVideo/source/durSec 一个都不在这里，
//   计价链路（r2vTokens 的输入时长）与它完全无关。路由再加两道：仅作者、仅 pending。
//
// ★ label 收**字符串**，且**不校"是数字""连续""与原来的个数相同"**：
//   · 不校数字 —— 编号是画在人偶头上的东西，实测是阿拉伯数字，但校验它没有任何好处：
//     真出现 "1a" 这种，作者原样抄进来才对得上画面，我们替他"规整"就是把卡挂错人；
//   · 不校连续 —— 1/2/4/5 是**实测的正常输出**，校连续等于把正确的确认判成非法；
//     · 不锁个数 —— 视觉可能少认一个人（画面里 5 个只列了 4 个），作者补一条比
//     "只能确认 AI 认出的那些"诚实；**也可能反过来多认**，或者编号根本没印上画面
//     （2026-08-15 实测一段 5 人素材实出 2/2/1/1/5 —— 两组重号、3 和 4 整个没出现），
//     那时作者要做的是**删掉画面上找不到的那几个位子**，个数当然会变少。
//     **但个数的上限锁住**：它与 parseRoles 的截断必须是同一个数（BLOCKOUT_ROLE_MAX），
//     否则作者能从这条路把角色位加到 10 个以上，而套用侧的参考图预算
//     （方舟 2.5 上限 30 张 ÷ 每张人物卡 2~3 张图）兜不住那么多。
//
// ★★ 下限（"至少留一个"）**不在这里**，在路由 handler 里（2026-08-15 从这里挪走）：
//   zod 报错会被 middleware/error.js 统一抹成英文 `"Validation error"`。删角色位从
//   "偶尔为之"变成**常规操作**之后，作者撞上下限的概率大增，而他会看到一句机器话，
//   完全不知道下一步该干什么（正确答案是"整个模板不要了就删模板"）。
//   规则本身仍然只有一处实现 —— 只是那一处搬到了说得出人话的地方。
const roleItemBody = z.object({
  // 标记本身（序数模板是位置措辞「从左数第3个」，老模板是数字「1」）。
  // ★ maxlength 与 models/BranchTemplate.roleSchema 的 8 对齐，**两次换代都一个字没改**：
  //   序数措辞最长 `从左数第9个` = 6 字，正是照着这个 8 定的（ordinalSlots 措辞规则⑥）。
  label: z.string().trim().min(1).max(8),
  // 「这个位子原来是谁」。套用者挂卡时**只看这句话**，所以作者可以改写得更好认
  desc: z.string().trim().max(300).optional().default(""),
});

const patchRolesBody = z.object({
  // ★ 只锁上限（跨仓一处实现，见上）。下限由路由 handler 用中文整句拒 ——
  //   缺 `roles` 这个键仍然在这里被拦（形状不对），而 `roles: []` 是**形状合法、
  //   语义非法**的那一类，交给说得出人话的那一层。
  roles: z.array(roleItemBody).max(BLOCKOUT_ROLE_MAX),
});

// 市场人话分类（PATCH /templates/:id/category）。宽松字符串不 enum：分类表活在客户端
// （app 仓 types.TPL_CATEGORIES），加新分类不该要求先发服务端。空串 = 清掉分类。
const setCategoryBody = z.object({
  category: z.string().trim().max(20),
});

module.exports = { createTemplateBody, blockoutizeBody, finishBlockoutizeBody, patchRolesBody, setCategoryBody, HTTPS_RE };
