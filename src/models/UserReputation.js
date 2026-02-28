/**
 * @file UserReputation.js - 用户声誉模型
 * @category Model
 * @description 记录用户之间的点赞和倒踩，用于计算用户声誉标注
 * 
 * 业务规则:
 * - 每个用户只能对另一个用户进行一次评价（点赞或倒踩）
 * - 可以修改评价（从点赞改为倒踩，反之亦然）
 * - 可以取消评价（删除记录）
 * - 只有在点赞数和倒踩数都>10时才计算声誉标注
 * - 使用比例判断：点赞数/倒踩数 >= 3 为"赞誉用户"，<= 0.33 为"恶意用户"
 * 
 * 索引:
 * - 唯一索引：fromUserId + toUserId（确保每个用户只能评价另一个用户一次）
 * - 普通索引：toUserId（用于快速查询某用户收到的所有评价）
 * 
 * 关联:
 * - fromUserId: User（评价者）
 * - toUserId: User（被评价者）
 */

const mongoose = require("mongoose");

const UserReputationSchema = new mongoose.Schema(
  {
    // 评价者
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    
    // 被评价者
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    
    // 评价类型: 1=点赞(like), -1=倒踩(dislike)
    vote: {
      type: Number,
      required: true,
      enum: [1, -1],
    },
  },
  { timestamps: true }
);

// 唯一索引：确保每个用户只能对另一个用户评价一次
UserReputationSchema.index({ fromUserId: 1, toUserId: 1 }, { unique: true });

// 计算用户的声誉统计（静态方法）
UserReputationSchema.statics.getReputationStats = async function (userId) {
  const stats = await this.aggregate([
    { $match: { toUserId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        likes: { $sum: { $cond: [{ $eq: ["$vote", 1] }, 1, 0] } },
        dislikes: { $sum: { $cond: [{ $eq: ["$vote", -1] }, 1, 0] } },
      },
    },
  ]);

  if (!stats || stats.length === 0) {
    return { likes: 0, dislikes: 0, badge: null };
  }

  const { likes, dislikes } = stats[0];

  // 计算声誉标注
  let badge = null;
  if (likes > 10 && dislikes > 10) {
    const ratio = likes / dislikes;
    if (ratio >= 3) {
      badge = "popular"; // 赞誉用户
    } else if (ratio <= 0.33) {
      badge = "malicious"; // 恶意用户
    }
  }

  return { likes, dislikes, badge };
};

module.exports = mongoose.model("UserReputation", UserReputationSchema);
