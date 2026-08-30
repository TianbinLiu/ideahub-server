// 「我收藏了哪条作品」—— 用户与分支视频之间的关系表。
//
// ★★ 为什么单开一张表，而不是复用 `BranchAssetLike` 加一个 `kind: "video"`：
//   作品的「赞」已经在 `BranchLike`。再把「收藏」塞进 asset 那张表，就会变成
//   同一个实体的两种互动分属两张表、两套计数、两套级联 —— 删作品时要记得删两处、
//   删号时要记得删两处，而漏掉哪一处都零症状。**复用形状，别复用表。**
//   （`MemeCollect` 是另一个产品线的同义表，同理不复用。）
//
// ★★ **没有计数字段，也不打算加**（2026-08-31 的决定，理由写在这儿免得被"顺手补上"）：
//   ① 收藏是零成本动作、注册成本也接近零 —— 它会是全站最便宜的刷量燃料；
//   ② 本仓两周前刚**亲手撤掉**首页那个收藏数（FeedPage 的 ★★：「显示一个骗人的数
//      比不显示更糟：作者会拿它判断作品受不受欢迎」），那条理由今天依然成立；
//   ③ 真要显示，`countDocuments` 随时能算 —— **关系表本身就是回填源**，
//      不存在"事后补不回来"。所以不存在"先加着以后再说"的理由，只有一把上膛的枪。
const mongoose = require("mongoose");

const branchCollectSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
  },
  { timestamps: true }
);

// 同一个人对同一条只收藏一次（幂等靠它，不靠调用方先查一遍）
branchCollectSchema.index({ user: 1, video: 1 }, { unique: true });
// 「我的收藏」按收藏时间倒序 —— 那才是用户预期的顺序（不是作品发布时间）
branchCollectSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("BranchCollect", branchCollectSchema);
