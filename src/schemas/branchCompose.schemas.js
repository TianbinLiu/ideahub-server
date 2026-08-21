// src/schemas/branchCompose.schemas.js
// 成片合并请求校验（zod）。
//
// ⚠ `z.object` 默认 **strip 未声明字段** —— 这里的取舍与 branchTemplate.schemas 一致：
//   **strip 在这条路上是帮手，不是漏洞**。刻意不收的两样：
//   · BGM 的时长 —— 它决定循环几次（`e_loop`），只能由服务端向 Cloudinary 取。
//     收客户端报的数 = 让用户自己决定 BGM 铺多长，报小了配乐中途断掉、报大了白烧配额。
//   · 任何 public_id / 变换串 —— 客户端只发**投递地址**，public_id 由服务端从地址里解，
//     变换串由服务端拼（utils/videoCompose 一处实现）。让客户端拼变换 = 让它绕开尺寸归一
//     与裁剪形状那三道防静默失败的闸。
//
// ★ 这里只做**逐字段**的形状校验；跨字段的规则（endSec > startSec、总时长上限、
//   宽高必须偶数、段落归属）都在 routes/branchCompose 里，因为它们要报"第几段不对"
//   这种能直接行动的话，而 zod 的报错形状做不到（铁律八：失败要看得懂）。
const { z } = require("../middleware/validate");
// 段数上限只有 utils/videoCompose.COMPOSE_LIMITS 一处（别在这儿抄一个数：
// 改上限时改一处漏一处没有任何症状，只会变成"schema 放进来 12 段、真正拼 5 段"）
const { COMPOSE_LIMITS } = require("../utils/videoCompose");

const clipItem = z.object({
  /** 段落的投递地址（转存后拿到的 secure_url）。归属与目录由路由校验 */
  url: z.string().trim().min(1).max(2000),
  startSec: z.number().nonnegative().max(COMPOSE_LIMITS.maxTotalSec),
  endSec: z.number().positive().max(COMPOSE_LIMITS.maxTotalSec),
});

const composeBody = z.object({
  clips: z.array(clipItem).min(1).max(COMPOSE_LIMITS.maxClips),
  /** 输出尺寸。★ 由客户端给：那个数是剪辑页 outSize(分辨率, 画幅) 算出来的，
   *  在这边再抄一张分辨率表就是同一条规则的第二处实现（两仓分叉时零症状）。
   *  服务端只校验它在合理区间且是偶数（h264 要求），并按它计费——所以有上限。 */
  width: z.number().int().min(COMPOSE_LIMITS.minEdge).max(COMPOSE_LIMITS.maxEdge),
  height: z.number().int().min(COMPOSE_LIMITS.minEdge).max(COMPOSE_LIMITS.maxEdge),
  quality: z.enum(["good", "best"]).optional(),
  /** 背景音乐（可选）。url 必须是**本账号**在我们 Cloudinary 空间里的资产 —— 目前
   *  App 还没有音频上传口，所以这一位在客户端接上之前不会有人传；服务端先支持着，
   *  形状与校验一次做对，省得将来补的时候又开一条没人校验的旁路。 */
  audio: z
    .object({
      url: z.string().trim().min(1).max(2000),
      /** 0~1，与剪辑页那个滑块同一口径；服务端换算成 Cloudinary 的 -100..400 增量 */
      volume: z.number().min(0).max(1),
      /** true = 去掉各段原声只留 BGM；缺省 = 与原声混在一起 */
      replace: z.boolean().optional(),
    })
    .optional(),
});

module.exports = { composeBody };
