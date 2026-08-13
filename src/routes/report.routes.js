// src/routes/report.routes.js
// 举报。**导出两个 router**，因为它有两个身份完全不同的入口（挂载见 app.js）：
//   · publicRouter → /api/branch/reports          （requireAuth，谁都能发）
//   · adminRouter  → /api/admin/branch/reports    （requireRole(ADMIN_ROLE)，与既有
//                                                  /api/admin/* 那 8 条同一道门）
//
// ★ 为什么不把管理端那两条塞进 admin.routes.js：举报的读写共用同一套序列化与
//   同一份状态机（`Report.ACTION_STATUS`），拆到两个文件里，加一个动作或改一次回包形状
//   就得记得改两处（铁律六）。分成两个 router 只是**挂载点**不同，实现仍然只有一份。
// ★ 路径是**跨仓契约**（docs/api-contract.md「举报」），与 app 仓 `src/api/admin.ts`
//   的 PATHS 表逐字相等。改路径要两仓同时改 —— 真机上改错了**不会 404**：
//   Capacitor 的本地静态服务器对未命中路径回 200+index.html，表现成"一条举报都没有"。
const { Router } = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { userRateLimit } = require("../middleware/rateLimit");
const { validate, z } = require("../middleware/validate");
const { ADMIN_ROLE } = require("../utils/roles");
const Report = require("../models/Report");
const { createReport, listReports, resolveReport } = require("../controllers/report.controller");

// ★ 枚举一律取自模型（Report.TARGET_TYPES / REASONS / ACTIONS），不在这里重敲一遍：
//   抄一份的后果是"模型收得下、接口不认"（新理由静默 400）或反过来
//   （接口放行、mongoose 校验失败兜成 500），两种都难查。
// ★ z.object 默认 **strip 未声明字段**：往请求体里加字段必须同时改这里和模型，
//   只改一处的表现是"客户端发了、服务端 201 了、读回来没有"（deck / pricing 栽过两次）。
const createBody = z.object({
  targetType: z.enum(Report.TARGET_TYPES),
  // 只判形状（24 位十六进制 = ObjectId），合法性在 controller 里再判一次 400 ——
  // 不判的话 Mongo 的 CastError 会被兜成 500，而这是调用方拼错了参数
  targetId: z.string().trim().regex(/^[a-f0-9]{24}$/i, "targetId must be a 24-hex ObjectId"),
  reason: z.enum(Report.REASONS),
  // 500 是契约值，客户端输入框上限必须与它相等：客户端松了会收到一串 400，
  // 客户端紧了则是"服务端明明收得下、用户却打不完一句话"
  detail: z.string().trim().max(500).optional().default(""),
  // ⚠ 客户端（app 的 submitReport）还会带一个 `videoId` 作为上下文 —— 这里**故意不声明**，
  //   它会被 z.object strip 掉。不是遗漏：那是**外部输入**，伪造一个别的作品 id 就能
  //   让管理员点去看错误的现场。评论/弹幕属于哪条作品由服务端按 targetId **现查**
  //   （见 controller 的 resolveTargets），那份才是权威的。
});

const resolveBody = z.object({
  // ★ 只收**动作**，不收目标状态（比如 `status: "taken_down"`）——
  //   那样客户端就能直接把一条举报标成"已下架"而没有任何内容被下架。
  //   动作 → 状态的映射只有一处实现：models/Report.js 的 ACTION_STATUS。
  action: z.enum(Report.ACTIONS),
  note: z.string().trim().max(500).optional().default(""),
});

// ★★ 举报是**可滥用面**，必须限流，而且按【账号】计（userRateLimit）：
//   这条在 requireAuth 后面，按 IP 计等于"换个出口就重开一桶"（手机切流量、代理池，
//   成本近乎零），同时又会让同一个 NAT 后面的真人互相抢额度
//   （理由与 branchVideo.routes 的发评论那条逐字相同，出处在 rateLimit.js）。
//
// ★ 两个窗口都要，缺一个都挡不住实际会发生的滥用：
//   · 10/分钟 —— 挡住"对着一份 id 列表跑循环"。正常人举报是看到一条不舒服的东西才点一次，
//     一分钟点十次已经远超真人节奏。
//   · 50/天 —— 只有短窗的话，一天跑 1440 分钟 × 10 = 一万四千条照样能把队列埋掉；
//     长窗才是真正的天花板。50 条/天对真人来说高得离谱，对刷子来说是硬顶。
//   两个桶 scope 分开，否则短窗一被吃满长窗就没意义了。
//   ⚠ 唯一索引只保证"同一个人对同一个对象一次"，挡不住"一个人举报一千个不同对象"——
//     那正是这两个桶存在的理由。
const createLimit = [
  userRateLimit({ windowMs: 60 * 1000, max: 10, scope: "report:create" }),
  userRateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 50, scope: "report:daily" }),
];

// ── 普通用户：提交举报 ────────────────────────────────────────────
const publicRouter = Router();
publicRouter.post("/", requireAuth, ...createLimit, validate({ body: createBody }), createReport);

// ── 管理员：列队 / 处理 ───────────────────────────────────────────
// ★ 普通用户打这两条得到的是 **403**，不是 404：这里没有"存在性"要保护
//   （路径本身就写在契约里，藏不住也没必要藏），403 一个字节的新信息都没多给。
//   与作品可见性那边"一律 404"是两回事 —— 那边要藏的是"这条作品在不在"，
//   这边要藏的是"队列里有什么"，而队列内容根本没返回。
// ★ 「谁是管理员」走 utils/roles 的 ADMIN_ROLE 一处判据，不在这里写字面量 "admin"
//   （铁律六：角色名散着写，哪天多出一个 moderator 就会漏改且不报错）。
//
// ★ 列表查询参数（status / targetType / page / limit）的校验在 controller 里做，
//   **不走 validate({ query })**：Express 5 的 req.query 是只读 getter，
//   validate 里的 `req.query = ...` 会静默失效（listVideos 那边同样的坑，同样的做法）。
const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(ADMIN_ROLE));
adminRouter.get("/", listReports);
adminRouter.patch("/:id", validate({ body: resolveBody }), resolveReport);

module.exports = { publicRouter, adminRouter };