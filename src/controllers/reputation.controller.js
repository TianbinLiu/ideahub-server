/**
 * @file reputation.controller.js - 用户声誉控制器
 * @category Controller
 * @description 处理用户的点赞/倒踩操作
 */

const UserReputation = require("../models/UserReputation");
const AppError = require("../utils/AppError");

/**
 * @api POST /api/users/:userId/reputation
 * @desc 对某个用户进行点赞或倒踩
 * @body { vote: 1 | -1 }  1=点赞, -1=倒踩
 * @returns { ok: true, action: 'voted' | 'removed' | 'updated', stats: {...} }
 */
async function voteUser(req, res, next) {
  try {
    const fromUserId = req.user._id;
    const toUserId = req.params.userId;
    const { vote } = req.body;

    // 验证vote值
    if (vote !== 1 && vote !== -1) {
      throw new AppError("Invalid vote value. Must be 1 (like) or -1 (dislike).", 400);
    }

    // 不能给自己投票
    if (fromUserId.toString() === toUserId) {
      throw new AppError("Cannot vote for yourself.", 400);
    }

    // 查找现有评价
    const existing = await UserReputation.findOne({ fromUserId, toUserId });

    let action;
    if (!existing) {
      // 新增评价
      await UserReputation.create({ fromUserId, toUserId, vote });
      action = "voted";
    } else if (existing.vote === vote) {
      // 取消评价（删除）
      await UserReputation.deleteOne({ _id: existing._id });
      action = "removed";
    } else {
      // 修改评价
      existing.vote = vote;
      await existing.save();
      action = "updated";
    }

    // 返回更新后的声誉统计
    const stats = await UserReputation.getReputationStats(toUserId);

    res.json({ ok: true, action, stats });
  } catch (err) {
    next(err);
  }
}

/**
 * @api GET /api/users/:userId/reputation
 * @desc 获取某个用户的声誉统计和当前用户的投票状态
 * @returns { ok: true, stats: {...}, myVote: 1 | -1 | null }
 */
async function getUserReputation(req, res, next) {
  try {
    const toUserId = req.params.userId;
    const fromUserId = req.user?._id;

    // 获取声誉统计
    const stats = await UserReputation.getReputationStats(toUserId);

    // 获取当前用户的投票状态
    let myVote = null;
    if (fromUserId) {
      const existing = await UserReputation.findOne({ fromUserId, toUserId });
      if (existing) {
        myVote = existing.vote;
      }
    }

    res.json({ ok: true, stats, myVote });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  voteUser,
  getUserReputation,
};
