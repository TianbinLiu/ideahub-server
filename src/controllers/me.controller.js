// src/controllers/me.controller.js
// 当前用户账号级操作。目前只有「注销账号」（软删除）。
const User = require("../models/User");
const { badRequest } = require("../utils/http");

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

module.exports = { deactivateAccount };
