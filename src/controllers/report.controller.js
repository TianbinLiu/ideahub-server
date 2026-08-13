// src/controllers/report.controller.js
// 举报：用户提交 + 管理员列队 / 处理。
//
// 契约见 app 仓 docs/api-contract.md「举报」（铁律九）。
const mongoose = require("mongoose");
const Report = require("../models/Report");
const BranchVideo = require("../models/BranchVideo");
const BranchComment = require("../models/BranchComment");
const BranchDanmaku = require("../models/BranchDanmaku");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { invalidId, notFound } = require("../utils/http");

const USER_FIELDS = "_id username displayName avatarUrl";

function isValidId(id) {
  return mongoose.isValidObjectId(id);
}

// ── 下架：**不在这里实现** ────────────────────────────────────────
/**
 * 取「下架」的唯一实现。
 *
 * ★★ 举报处理**绝不自己写一份下架逻辑**（铁律六）。下架要连带清理的东西一长串
 *   （评论树、点赞行、弹幕、指向它的通知、计数回写……见 branchVideo.controller 的
 *   removeVideo / purgeComments），在这里抄一份的结果一定是漏掉其中一两样，
 *   而漏了不报错 —— 只是库里留下一堆谁也查不到、也删不掉的行。
 *
 * ★ 所以这里只**调用**另一条线的下架服务。约定的接口（同步给那条线）：
 *     require("../services/takedown.service").takedownTarget({
 *       targetType, targetId, operatorId, reason,
 *       hard,   // false = 下架（内容还在，谁都看不到）；true = 硬删除（不可撤销）
 *     }) => Promise<{ removed?: number, ... }>   // 失败请 throw
 *   ★ 「下架」与「删除」是**两个动作、一个服务**：两者要清理的东西高度重合，
 *     拆成两个入口就会分叉。差别只有这个 `hard` 标志。
 *
 * ★★ 服务不在（部署漏了文件、或那条线还没落地）时**返回 501 并原地不动**，
 *   绝不把举报标成"已处理"：把状态改成 taken_down 而内容还挂在首页上，
 *   是这一整块里最坏的一种失败 —— 管理员以为处理完了，举报者以为被受理了，
 *   而那条内容一直在线，且没有任何报错（铁律八：不许静默失败）。
 *   服务**自己抛错**时同样不写状态（那条 await 直接把异常交给 errorHandler）。
 * ★ 懒加载而不是文件顶部 require：takedown.service 反过来 require
 *   branchVideo.controller，顶部 require 会把这条依赖变成加载期的环。
 *
 * @returns {Function|null} 拿不到就是 null
 */
let takedownFn; // undefined = 还没探测过；null = 探测过、不存在
function loadTakedown() {
  if (takedownFn !== undefined) return takedownFn;
  try {
    const mod = require("../services/takedown.service");
    const fn = mod && typeof mod.takedownTarget === "function" ? mod.takedownTarget : null;
    if (!fn) console.warn("[report] takedown.service 存在但没有导出 takedownTarget()，下架不可用");
    takedownFn = fn;
  } catch (err) {
    // 只吞"这个模块不存在"，模块内部自己的报错必须原样抛出去 ——
    // 否则那条线写错一行 require，表现会变成"下架功能整块消失"（与 branchAsset.routes 同一招）
    const selfMissing =
      err && err.code === "MODULE_NOT_FOUND" && /takedown\.service/.test(String(err.message || ""));
    if (!selfMissing) throw err;
    takedownFn = null;
  }
  return takedownFn;
}

// ── 序列化 ───────────────────────────────────────────────────────

function toUserPayload(user) {
  if (!user) return null;
  if (typeof user === "object" && user._id) {
    return {
      _id: user._id,
      username: user.username || "",
      displayName: user.displayName || "",
      avatarUrl: user.avatarUrl || "",
    };
  }
  return user; // 未 populate 时是裸 ObjectId
}

/**
 * 一条举报。
 * ★ `status` 兜一层 `|| "pending"`：这一列是 required + default，理论上不会缺，
 *   但对外的形状不该依赖"理论上"——客户端按 `!== "pending"` 判已处理，
 *   一个 undefined 就会被判成"已处理"，用户看到的是"你的举报已受理"而其实没人碰过。
 */
function toReportPayload(doc, ctx = {}) {
  if (!doc) return null;
  return {
    _id: doc._id,
    targetType: doc.targetType,
    targetId: doc.targetId,
    reason: doc.reason,
    detail: doc.detail || "",
    status: doc.status || "pending",
    reporter: toUserPayload(doc.reporter),
    handler: toUserPayload(doc.handler),
    handledAt: doc.handledAt || null,
    handleNote: doc.handleNote || "",
    createdAt: doc.createdAt,
    ...(ctx.target ? { target: ctx.target } : {}),
    ...(ctx.stats ? { reportCount: ctx.stats.total, pendingCount: ctx.stats.pending } : {}),
  };
}

// ── 提交（普通用户）────────────────────────────────────────────

/**
 * POST /api/branch/reports
 *
 * ★★ 这里**刻意不校验被举报对象存在 / 当前用户看不看得见**。
 *   任何"存在就 201、不存在就 404"的写法，都会把这条端点变成一个探测私密作品的旁路
 *   —— 拿一串 id 挨个试，凭状态码就能把库里有哪些作品、哪条评论属于哪条作品数出来
 *   （与 assertVisible 挡的是同一类旁路，那边为此把 403 全改成了 404）。
 *   而举报**天然**是"我刚才看到了这个东西"：看不见就不会有举报入口，校验换不来什么。
 *   代价（有人举报一串不存在的 id）由三样兜住：
 *     ① 唯一索引 —— 同一个人对同一个 id 只能来一次；
 *     ② 限流 —— 见 report.routes.js 的两个桶；
 *     ③ 管理端**现查**对象，查不到就如实标 `target.exists = false`，一眼能筛掉。
 *   顺带还避免了在这里抄第三份可见性规则（铁律六）——那份规则收在
 *   branchVideo.controller 的 visibilityFilter/visibleTo 里，这里够不着，也不该够得着。
 */
async function createReport(req, res, next) {
  try {
    const { targetType, targetId, reason, detail } = req.body;
    // 形状还是要判：非法 id 直接进 Mongo 会被 CastError 兜成 500，
    // 而这是调用方拼错了参数，该是 400（与 listVideos 的 author 同一条理由）。
    if (!isValidId(targetId)) invalidId("Invalid target id");

    const filter = { reporter: req.user._id, targetType, targetId };

    // 预检：给出一句人话，并把首次那条原样还回去（客户端可以据此显示"已受理/已处理"）
    const dup = await Report.findOne(filter).lean();
    if (dup) {
      throw new AppError({
        code: CODES.DUPLICATE,
        status: 409,
        message: "You have already reported this content",
        details: { reportId: dup._id, status: dup.status || "pending" },
      });
    }

    let doc;
    try {
      doc = await Report.create({
        reporter: req.user._id,
        targetType,
        targetId,
        reason,
        detail: detail || "",
      });
    } catch (err) {
      // 两次点击几乎同时到达：上面的预检双双扑空，唯一索引在这里兜底
      if (err && err.code === 11000) {
        const again = await Report.findOne(filter).lean();
        throw new AppError({
          code: CODES.DUPLICATE,
          status: 409,
          message: "You have already reported this content",
          details: again ? { reportId: again._id, status: again.status || "pending" } : undefined,
        });
      }
      throw err;
    }

    res.status(201).json({ ok: true, report: toReportPayload(doc) });
  } catch (err) {
    next(err);
  }
}

// ── 管理端：列队 ─────────────────────────────────────────────────

/**
 * 把这一页举报指向的对象**现查**出来。
 *
 * ★ 按类型分三批查，不是逐条查：一页 20 条就是 20 次往返。
 * ★ 查不到一律给 `{ exists: false }`，**不是**把这一项省掉 —— 省掉的话管理端分不出
 *   "对象已经没了"和"我们忘了查"（铁律八）。作者自己删掉、或已经被下架过，都会走这条。
 * ★★ 弹幕这一项会带出 `author`。这是**整个系统里唯一**一处透出弹幕作者的地方，
 *   而弹幕对普通用户是匿名的（契约「弹幕」：对外只有一个 `mine` 布尔）。
 *   这条例外成立的前提是**这个端点整条挂在 requireRole("admin") 后面** ——
 *   哪天把列表端点放开给普通用户（比如做"我的举报"），必须先把这个字段摘掉，
 *   否则举报一次就能查出某条弹幕是谁发的，整面弹幕墙都被去匿名化了。
 */
async function resolveTargets(rows) {
  const idsByType = { video: [], comment: [], danmaku: [] };
  for (const r of rows) {
    if (idsByType[r.targetType]) idsByType[r.targetType].push(r.targetId);
  }

  const out = new Map(); // `${type}:${id}` → payload
  const put = (type, id, payload) => out.set(`${type}:${String(id)}`, payload);

  const [videos, comments, danmaku] = await Promise.all([
    idsByType.video.length
      ? BranchVideo.find({ _id: { $in: idsByType.video } })
          .select("_id title cover visibility takedown author createdAt")
          .populate("author", USER_FIELDS)
          .lean()
      : [],
    idsByType.comment.length
      ? BranchComment.find({ _id: { $in: idsByType.comment } })
          .select("_id video text author createdAt")
          .populate("author", USER_FIELDS)
          .lean()
      : [],
    idsByType.danmaku.length
      ? BranchDanmaku.find({ _id: { $in: idsByType.danmaku } })
          .select("_id video text at author createdAt")
          .populate("author", USER_FIELDS)
          .lean()
      : [],
  ]);

  for (const v of videos) {
    put("video", v._id, {
      exists: true,
      videoId: v._id,
      title: v.title || "",
      cover: v.cover || "",
      // 归一，与作品详情同口径：老作品这一列是 undefined，直接透出去客户端还得再判一次
      visibility: v.visibility === "private" ? "private" : "public",
      // ★ 这一列**原样**带出来（没下架就是 null），管理端据 `takedown.at` 存不存在
      //   显示"已处于下架状态"。刻意不在这里算一个 `takenDown` 布尔：
      //   "怎么判一条作品下没下架"是 branchVideo.controller 的 `isTakenDown` 一处说了算
      //   （判据是 `takedown.at` 是不是 Date，见那里关于 `takedown: null` 坏数据的说明），
      //   在这里再写一遍 `!!(v.takedown && v.takedown.at)` 就是第三份判断（铁律六）。
      //   ⚠ 队列里能看到"已下架但还有待处理举报"是正常的：管理员也可能走
      //     POST /api/admin/branch/videos/:id/takedown 直接下架，那条路不碰举报队列。
      takedown: v.takedown || null,
      author: toUserPayload(v.author),
      createdAt: v.createdAt,
    });
  }
  for (const c of comments) {
    put("comment", c._id, {
      exists: true,
      videoId: c.video,
      text: c.text || "",
      author: toUserPayload(c.author),
      createdAt: c.createdAt,
    });
  }
  for (const d of danmaku) {
    put("danmaku", d._id, {
      exists: true,
      videoId: d.video,
      text: d.text || "",
      at: d.at,
      author: toUserPayload(d.author), // ← 见函数头 ★★：admin-only
      createdAt: d.createdAt,
    });
  }

  return out;
}

/** 这一页每个对象各被举报了多少次 / 其中还有几条待处理 */
async function loadTargetStats(rows) {
  if (!rows.length) return new Map();
  const pairs = rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId }));
  const agg = await Report.aggregate([
    { $match: { $or: pairs } },
    {
      $group: {
        _id: { t: "$targetType", i: "$targetId" },
        total: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
      },
    },
  ]);
  const out = new Map();
  for (const g of agg) {
    out.set(`${g._id.t}:${String(g._id.i)}`, { total: g.total, pending: g.pending });
  }
  return out;
}

/**
 * GET /api/admin/branch/reports —— 举报队列（仅管理员）。
 *
 * ★ `status` **默认只给 pending**：这个端点存在的全部理由就是"还有什么要我看"。
 *   默认给全部的话，处理完一千条之后，待处理的那三条就沉在第五十页了。
 *   要看全部传 `status=all`。
 * ★ 生效的 `status` 会**原样回显**在响应里 —— 与 listVideos 回显 `author` 同一招：
 *   老服务端不认这个参数只会照常返回，客户端光看内容分不出"筛过、没有待处理的"
 *   与"压根没筛、这一页恰好是这样"。回显一个键就把它变成判形状。
 * ★ 分页用 page/skip 而不是 cursor：与 /api/admin/* 现有列表一致（管理端要能跳页），
 *   且队列量级远小于首页信息流。
 */
async function listReports(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);

    const rawStatus = typeof req.query.status === "string" && req.query.status ? req.query.status : "pending";
    if (rawStatus !== "all" && !Report.STATUSES.includes(rawStatus)) {
      // 不静默退回默认值：拼错一个字就悄悄给你另一份数据，比报错难查得多（铁律八）
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: `Invalid status: ${rawStatus}`,
        details: { allowed: [...Report.STATUSES, "all"] },
      });
    }

    const rawType = typeof req.query.targetType === "string" ? req.query.targetType : "";
    if (rawType && !Report.TARGET_TYPES.includes(rawType)) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: `Invalid targetType: ${rawType}`,
        details: { allowed: Report.TARGET_TYPES },
      });
    }

    const filter = {
      ...(rawStatus === "all" ? {} : { status: rawStatus }),
      ...(rawType ? { targetType: rawType } : {}),
    };

    const [rows, total] = await Promise.all([
      Report.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("reporter", USER_FIELDS)
        .populate("handler", USER_FIELDS)
        .lean(),
      Report.countDocuments(filter),
    ]);

    const [targets, stats] = await Promise.all([resolveTargets(rows), loadTargetStats(rows)]);

    res.json({
      ok: true,
      items: rows.map((r) => {
        const key = `${r.targetType}:${String(r.targetId)}`;
        return toReportPayload(r, {
          target: targets.get(key) || { exists: false },
          stats: stats.get(key) || { total: 1, pending: r.status === "pending" ? 1 : 0 },
        });
      }),
      total,
      page,
      limit,
      status: rawStatus, // ← 能力探针，见函数头
      ...(rawType ? { targetType: rawType } : {}),
    });
  } catch (err) {
    next(err);
  }
}

// ── 管理端：处理一条 ──────────────────────────────────────────────

/**
 * PATCH /api/admin/branch/reports/:id —— 处理一条举报（仅管理员）。
 *
 * body `{ action: "takedown" | "delete" | "dismiss", note? }`
 *
 * ★ 只能从 pending 出发，已处理的再处理一次回 409。不是洁癖：两个管理员同时点"下架"，
 *   不判这一下就会走两遍下架流程、写两遍处理人（后写的把先写的盖掉，日志上看不出）。
 * ★ 动作 → 状态的映射取自 `Report.ACTION_STATUS` 一张表（铁律六），这里不写 if。
 * ★ takedown / delete 成功后，**同一个对象上其余待处理的举报一起收尾**（内容已经没了
 *   或已经看不到了，剩下那些谁也处理不了）。留着不管的表现是队列里永远躺着一批点开
 *   只显示"对象已不存在"的死条目 —— 与"删了作品不清通知"是同一个形状的坑。
 *   `dismiss` **不**级联：不同人可能举报的是不同理由，驳回"垃圾广告"不代表"色情"也不成立。
 */
async function resolveReport(req, res, next) {
  try {
    const { id } = req.params;
    if (!isValidId(id)) invalidId("Invalid report id");

    const { action, note } = req.body;
    // 需要真的动到内容的两个动作。dismiss 只写一行状态，不碰任何内容。
    const touchesContent = action === "takedown" || action === "delete";

    const report = await Report.findById(id).lean();
    if (!report) notFound("Report not found");
    if ((report.status || "pending") !== "pending") {
      throw new AppError({
        code: CODES.DUPLICATE,
        status: 409,
        message: "This report has already been handled",
        details: { status: report.status, handledAt: report.handledAt || null },
      });
    }

    let takedownResult = null;
    if (touchesContent) {
      const takedown = loadTakedown();
      if (!takedown) {
        // ★★ 如实说：状态原地不动，什么都没被下架 / 删除。
        //   501 = "这个服务端还没实现这件事"，与 4xx（你请求错了）分得开。
        console.warn(
          `[report] 收到 ${action} 请求但 services/takedown.service.js 未落地 report=${id} target=${report.targetType}:${report.targetId}`
        );
        throw new AppError({
          code: "TAKEDOWN_UNAVAILABLE",
          status: 501,
          message:
            "下架/删除尚未接入（缺 services/takedown.service.js 的 takedownTarget）：这条举报仍是待处理，没有任何内容被动过。可先用 action=dismiss 驳回。",
          details: {
            reportId: report._id,
            status: report.status || "pending",
            action,
            applied: false,
          },
        });
      }
      // 下架本身失败（内容已不存在、权限问题…）也**绝不**改状态：交给 errorHandler，
      // 管理员看到的是失败，队列里那条还在，可以重来。
      takedownResult = await takedown({
        targetType: report.targetType,
        targetId: report.targetId,
        operatorId: req.user._id,
        reason: report.reason,
        hard: action === "delete",
      });
    }

    const patch = {
      status: Report.ACTION_STATUS[action],
      handler: req.user._id,
      handledAt: new Date(),
      handleNote: typeof note === "string" ? note : "",
    };

    const updated = await Report.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after" })
      .populate("reporter", USER_FIELDS)
      .populate("handler", USER_FIELDS)
      .lean();

    let alsoResolved = 0;
    if (touchesContent) {
      const r = await Report.updateMany(
        {
          targetType: report.targetType,
          targetId: report.targetId,
          status: "pending",
          _id: { $ne: report._id },
        },
        { $set: patch }
      );
      alsoResolved = Number(r?.modifiedCount || 0);
    }

    res.json({
      ok: true,
      report: toReportPayload(updated),
      // 真的动到内容了才是 true。前面那条 501 分支永远走不到这里。
      applied: touchesContent,
      ...(takedownResult && typeof takedownResult === "object" ? { takedown: takedownResult } : {}),
      alsoResolved,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createReport,
  listReports,
  resolveReport,
};
