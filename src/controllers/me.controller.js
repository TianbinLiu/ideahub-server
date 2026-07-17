// src/controllers/me.controller.js
// 当前用户账号级操作：注销账号（软删除）、虚拟点数余额与流水。
const User = require("../models/User");
const PointsLedger = require("../models/PointsLedger");
const { badRequest, notFound } = require("../utils/http");

// POST /api/me/deactivate —— 注销账号（软删除，可恢复）
//
// ★软删除语义：只在 User 上打 deactivatedAt 时间戳，【不删任何内容数据】
//   （想法 / 评论 / 赏金 / 风格档案等一律原样保留），因此随时可以由管理员
//   把 deactivatedAt 置回 null 来恢复账号。这里【绝不能】写级联删除。
//
// 两件事必须一起做，缺一不可：
//   1. deactivatedAt = now —— auth 中间件据此把该账号视为未授权；
//   2. tokenVersion += 1  —— 让该账号【所有已签发的 token 立即失效】。
//      否则用户点了「注销」，手里的旧 token 仍然能用到过期为止（默认 7d）。
async function deactivateAccount(req, res, next) {
  try {
    const { confirmUsername } = req.body;

    // 必须与本人用户名【完全相同】：这是不可逆操作前的最后一道人工确认，
    // 所以不做 trim / 大小写归一化，严格全等。
    if (confirmUsername !== req.user.username) badRequest("用户名不匹配");

    // 原子更新：$set + $inc 一次写入，避免读-改-写竞态。
    await User.updateOne(
      { _id: req.user._id },
      { $set: { deactivatedAt: new Date() }, $inc: { tokenVersion: 1 } }
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ── 虚拟点数 ──────────────────────────────────────────────────────
// ★这是平台【虚拟点数】，不是真钱：无现金价值，不可提现/兑换，不接任何真实支付。

// GET /api/me/points —— 当前余额
async function getMyPoints(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select("points").lean();
    if (!user) notFound("User not found");

    // ★不给缺字段的账号兜底成 1000。缺 points 说明这个账号还没跑过 `npm run backfill:points`，
    //   而写入侧（points.service 的 {points:{$gte:X}} 条件更新）对它同样匹配不到 ——
    //   读写口径必须一致。宁可显示 0（去跑迁移），也不能显示一个账本里根本没有的余额。
    const points = Number.isFinite(user.points) ? user.points : 0;
    res.json({ ok: true, points });
  } catch (err) {
    next(err);
  }
}

// GET /api/me/points/ledger?page&limit —— 我的点数流水（分页）
async function listMyPointsLedger(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20", 10) || 20, 1), 50);

    // ★只查 user = 本人。托管分录（user:null）是平台内部账，不属于任何人，
    //   不得出现在任何用户的流水里 —— 这个 filter 就是那道边界，别加 $or。
    const filter = { user: req.user._id };

    const total = await PointsLedger.countDocuments(filter);
    const totalPages = Math.max(Math.ceil(total / limit), 1);

    // _id 是 createdAt 之外的第二排序键：一次转账的两条分录 createdAt 往往同一毫秒，
    // 只按 createdAt 排序时它们的相对顺序不稳定，翻页会重复或漏条。
    const rows = await PointsLedger.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      ok: true,
      entries: rows.map((row) => ({
        _id: row._id,
        delta: Number(row.delta || 0),
        reason: row.reason,
        balanceAfter: row.balanceAfter === undefined ? null : row.balanceAfter,
        bounty: row.bounty || null,
        memo: row.memo || "",
        createdAt: row.createdAt,
      })),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { deactivateAccount, getMyPoints, listMyPointsLedger };
