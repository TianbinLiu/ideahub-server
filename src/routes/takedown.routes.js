/**
 * @file takedown.routes.js - 非自愿私密影像（NCII）的移除请求：公开入口 + 管理端处理
 * @category Route
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md + 官网 /takedown 页 + app 仓 docs/api-contract.md
 *
 * ── 法条出处 ────────────────────────────────────────────────────────
 * TAKE IT DOWN Act（Pub. L. 119-12）§3：**2026-05-19 起 FTC 执法、无小企业豁免、
 * 民事罚款上限约 $53,088/次**。要求三件事：
 *   ① 站上**显著公示**移除流程（官网 /takedown，页脚与条款里都有入口）；
 *   ② 收到**有效请求**后 **48 小时内**移除；
 *   ③ 对**已知的相同副本**做合理查找并一并移除（services/nciiTakedown.service.js）。
 *
 * ★★ **公开入口不要登录**（`POST /api/takedown`）。受害者通常根本不是我们的用户 ——
 *    把入口挡在登录后面，这条通道对最需要它的人就等于不存在。
 *    滥用不是靠登录挡的，而是靠「**人工复核之后才移除**」：这个接口只收请求，不动任何内容。
 * ★★ 与站内举报（`/api/branch/reports`）是**两条通道，不要合并**：
 *    举报要求登录、指向站内某个对象、按队列处理；这条免登录、可以只给一个链接、有法定时限。
 *    站内举报里另加了一个 `ncii` 理由（Report.REASONS），那是给**已登录用户**的快捷入口，
 *    它落在举报队列的插队位（URGENT_REASONS），但**不产生**本表的 48 小时计时。
 *    ⇒ 两条都要有：一条满足法条，一条满足 Play「应用内可举报」。
 * ★ 请求人的 IP / UA **不落库**：法条不要求，而这是受害者的信息。反滥用只在中间件里按 IP 计数。
 */
const { Router } = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { validate, z } = require("../middleware/validate");
const { ADMIN_ROLE } = require("../utils/roles");
const mongoose = require("mongoose");
const TakedownRequest = require("../models/TakedownRequest");
const ncii = require("../services/nciiTakedown.service");

const publicRouter = Router();
const adminRouter = Router();

// ★ 有效请求的四个要件（§3(b)(1)(A)）逐条落在这里。少任何一个都不是「有效请求」，
//   48 小时的钟也就不该开始走 —— 所以缺件返回 400 并**点名**缺的是哪一件，
//   而不是含糊地说「参数错误」：给一个正处在这种处境里的人一句看不懂的报错，等于把她挡在门外。
const createBody = z.object({
  /** §3(b)(1)(A)(i) 电子签名：逐字打上本人姓名即可 */
  signature: z.string().trim().min(2).max(120),
  onBehalf: z.enum(TakedownRequest.ON_BEHALF).optional().default("self"),
  /** §3(b)(1)(A)(iv) 联系方式 */
  contactEmail: z.string().trim().email().max(200),
  contactPhone: z.string().trim().max(40).optional().default(""),
  /** §3(b)(1)(A)(ii) 位置：站内页面链接或图片/视频地址都行，至少一条 */
  urls: z.array(z.string().trim().min(4).max(2000)).min(1).max(30),
  locationNote: z.string().trim().max(2000).optional().default(""),
  /** §3(b)(1)(A)(iii) 好意相信未经同意 */
  statement: z.string().trim().max(2000).optional().default(""),
  affirmedNotConsensual: z.literal(true, { errorMap: () => ({ message: "affirmedNotConsensual must be true" }) }),
});

/**
 * 免登录提交移除请求。
 * ★ 限流按 IP：10 次/小时。宁可松一点 —— 卡太紧会把一个正在多个页面上找自己照片的人挡住，
 *   而每一条请求都要人工看，刷不出规模。
 */
publicRouter.post(
  "/",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10, scope: "takedown" }),
  validate({ body: createBody }),
  async (req, res, next) => {
    try {
      const doc = await TakedownRequest.create({
        kind: "ncii",
        signature: req.body.signature,
        onBehalf: req.body.onBehalf,
        contactEmail: req.body.contactEmail,
        contactPhone: req.body.contactPhone,
        urls: req.body.urls,
        locationNote: req.body.locationNote,
        statement: req.body.statement,
        affirmedNotConsensual: true,
        receivedAt: new Date(),
      });
      // 通知走邮件：48 小时是法定时限，不能指望有人正好打开管理后台。
      // ★ 发信失败**不影响**这次请求成功——请求已经落库、钟已经开始走；
      //   发不出去只说明我们自己可能错过时限，而那要靠到期清扫兜住（铁律八：响而局部）。
      ncii.notifyAdmins(doc).catch((e) => console.error("[takedown] notify failed:", (e && e.message) || e));
      res.status(201).json({
        ok: true,
        id: String(doc._id),
        receivedAt: doc.receivedAt,
        dueAt: doc.dueAt,
        slaHours: TakedownRequest.SLA_MS / 3600000,
      });
    } catch (e) {
      next(e);
    }
  }
);

// ── 管理端 ────────────────────────────────────────────────────────
// ★ 列表的查询参数就地解析，**不走 validate({ query })**：Express 5 的 req.query 是只读
//   getter，validate 里那句 `req.query = ...` 会抛错（report.routes / listVideos 同一个坑）。
adminRouter.get("/", requireAuth, requireRole(ADMIN_ROLE), async (req, res, next) => {
  try {
    const status = String(req.query.status || "").trim();
    if (status && !TakedownRequest.STATUSES.includes(status)) {
      return res.status(400).json({ message: "invalid status", code: "VALIDATION_ERROR" });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const filter = status ? { status } : {};
    // 排序键序与 TakedownRequest 的 {status, dueAt} 索引一致；最急的在最前。
    const items = await TakedownRequest.find(filter).sort({ status: 1, dueAt: 1 }).limit(limit).lean();
    const now = Date.now();
    res.json({
      ok: true,
      items: items.map((d) => ({ ...d, _id: String(d._id), overdue: d.status === "pending" && new Date(d.dueAt).getTime() < now })),
      pendingCount: await TakedownRequest.countDocuments({ status: "pending" }),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * 「已知相同副本」检索（§3(b)(1)(B)）。**单独一条接口、不在提交时自动跑**：
 * 它要遍历作品表，而且结果是给人看的 —— 自动跑一遍没人看，等于没跑。
 */
adminRouter.post("/:id/scan", requireAuth, requireRole(ADMIN_ROLE), async (req, res, next) => {
  try {
    // 形状不对的 id 直接 404：不判的话 Mongo 的 CastError 会被兜成 500（report.routes 同款）
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "not found", code: "NOT_FOUND" });
    const doc = await TakedownRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "not found", code: "NOT_FOUND" });
    const { urls, refs, truncated } = await ncii.findReferences(doc.urls);
    doc.copySearch = { ranAt: new Date(), foundCount: refs.length, truncated: truncated || [] };
    await doc.save();
    // truncated 不为空 = 这次检索**不完整**，调用方必须看得见（foundCount 是履行证据）
    res.json({ ok: true, urls, refs, truncated: truncated || [] });
  } catch (e) {
    next(e);
  }
});

const resolveBody = z.object({
  // ★ `pending` 也要能选（2026-09-25 评审）：置成 need_info 之后原来**没有任何接口**
  //   能把它放回队列，而请求人补了材料之后必须回得去 —— 否则那条请求永久停摆，
  //   `handledAt` 上还挂着一个看起来像「处理过」的时间戳。
  status: z.enum(["removed", "rejected", "need_info", "pending"]),
  handleNote: z.string().trim().max(1000).optional().default(""),
  removed: z
    .array(
      z.object({
        model: z.string().trim().max(60).optional().default(""),
        id: z.string().trim().max(64).optional().default(""),
        field: z.string().trim().max(60).optional().default(""),
        url: z.string().trim().max(2000).optional().default(""),
        action: z.string().trim().max(32).optional().default(""),
      })
    )
    .max(500)
    .optional()
    .default([]),
});

adminRouter.patch("/:id", requireAuth, requireRole(ADMIN_ROLE), validate({ body: resolveBody }), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "not found", code: "NOT_FOUND" });
    const doc = await TakedownRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: req.body.status,
          handleNote: req.body.handleNote,
          handler: req.user._id,
          // 放回队列时清掉处理时间戳：留着的话队列里那条看起来像「已经处理过」
          handledAt: req.body.status === "pending" ? null : new Date(),
          removed: req.body.removed,
          // 重新进入时限视野时，提醒档位也要重置，否则它再也不会响
          ...(req.body.status === "pending" ? { reminderStage: "" } : {}),
        },
      },
      { new: true }
    ).lean();
    if (!doc) return res.status(404).json({ message: "not found", code: "NOT_FOUND" });
    // 官网上承诺了「用邮件回复你结果」—— 这一步在这之前一个字都没发过
    if (req.body.status !== "pending") ncii.notifyRequester(doc).catch((e) => console.error("[takedown] 回复失败:", (e && e.message) || e));
    res.json({ ok: true, item: { ...doc, _id: String(doc._id) } });
  } catch (e) {
    next(e);
  }
});

module.exports = { publicRouter, adminRouter };
