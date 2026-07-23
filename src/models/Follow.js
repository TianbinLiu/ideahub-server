const mongoose = require('mongoose');

const followSchema = new mongoose.Schema({
  follower: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  following: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Ensure a user can't follow another user twice
followSchema.index({ follower: 1, following: 1 }, { unique: true });

// Prevent self-following
// ★新版 mongoose 的 pre hook 不再传 next（"next is not a function"）——直接 throw。
//   这个旧式签名曾让【所有关注操作】500（Follow.create 必炸），线上真机排查出来的存量 bug。
followSchema.pre('save', function () {
  if (this.follower.equals(this.following)) {
    throw new Error('Cannot follow yourself');
  }
});

module.exports = mongoose.model('Follow', followSchema);
