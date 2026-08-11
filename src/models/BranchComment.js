// src/models/BranchComment.js
// 分支视频评论。详情接口默认带出最新 50 条；BranchVideo.commentCount 由本表计数回写。
const mongoose = require("mongoose");

const branchCommentSchema = new mongoose.Schema(
  {
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },

    // 楼中楼：指向被回复的**顶层**评论。
    // ★ 判「这条是不是回复」一律看 parent 的**有无**（`if (doc.parent)`），
    //   绝不写成 `doc.parent === null` 之类的等值判断 —— 这个字段是后加的，
    //   存量评论读出来是 `undefined`，等值判会把它们整批判成"是回复"，
    //   于是老评论全部从评论区顶层消失（且一个错都不报）。
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "BranchComment", default: null, index: true },

    // 评论点赞数。权威计数在 BranchCommentLike（去重表）里，这里只是回写的快照，
    // 与 BranchVideo.likes ← BranchLike 同一套做法。
    likes: { type: Number, default: 0 },

    // 这条评论里**解析成功**的 @提及。服务端自己从 text 里解析（utils/mentionParser），
    // **不收客户端传上来的名单** —— 收了就等于让发评论的人指定"通知谁"，
    // 那是一个任意给陌生人发推送的接口。
    //
    // ★ 为什么要落库而不是每次读评论时重新解析：解析要查库（一次 $in + collation），
    //   评论列表一页 50 条就是 50 次；而且明天再读时用户名可能已经变了，
    //   重新解析会解析到**另一个人**身上（用户名是 unique 的，让出来就能被别人注册走）。
    //   身份在写入那一刻定死。
    // ★ 只存 `user` + `token`，**不存 displayName/username 快照**：显示名是可变的，
    //   存快照就会在对方改名后对不上（app 仓 renameMyVideos 那个坑的同一形状）。
    //   读的时候 populate 出**当下**的名字。
    //   `token` 必须存：它是用户键入时的原文（大小写可能与规范用户名不同），
    //   客户端就是拿它在正文里做子串匹配来加链接的，归一成 username 会在正文里找不到。
    //
    // 存量评论没有这个字段 → 读出来是 undefined。序列化处一律 `Array.isArray(x) ? x : []`
    // 归一成空数组：对老评论而言"没有提及"就是事实，不存在误判（见 controller）。
    mentions: {
      type: [
        new mongoose.Schema(
          {
            user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
            token: { type: String, required: true, maxlength: 80 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: true }
);

branchCommentSchema.index({ video: 1, createdAt: -1 });
// 顶层评论列表要 `{ video, parent: null }`，回复要 `{ parent: <id> }`，都吃这条
branchCommentSchema.index({ video: 1, parent: 1, createdAt: -1 });

module.exports = mongoose.model("BranchComment", branchCommentSchema);
