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

    // 这条评论里**核对通过**的 @提及。
    //
    // ★★ 身份是 `user`（userId），不是名字 —— 名字可变、不唯一，谁都不该靠它认人。
    //   来源有两条，都在 utils/mentionParser 一处实现（铁律六）：
    //     ① 客户端补全面板报上来的 `{userId, offset, length}`，服务端逐条核对
    //        「正文那一段确实写着这个人当下的名字」才收（中文昵称走这条）；
    //     ② 服务端自己从正文里扫出来的 ASCII `@username`（手打 / 老客户端走这条）。
    //   **不盲信**客户端的名单：不核对就等于开一个"给任意用户发推送"的接口
    //   （正文里一个 @ 都没有也能点名一百个人）。核对逻辑见 mentionParser。
    //
    // ★ 为什么要落库而不是每次读评论时重新解析：解析要查库，评论列表一页 50 条就是
    //   50 次；而且明天再读时名字可能已经变了，重新解析会解析到**另一个人**身上
    //   （username 是 unique 的，让出来就能被别人注册走）。身份在写入那一刻定死。
    // ★ **不存 displayName/username 快照**：显示名是可变的，存快照就会在对方改名后
    //   对不上（app 仓 renameMyVideos 那个坑的同一形状）。读的时候 populate 出**当下**
    //   的名字，渲染端据 offset/length 把正文里那一段换成当前显示名 —— 「改名后同步」
    //   就是这么实现的。
    // ★ `token` 必须存：它是用户键入时的**字面**（`@我是王桑` / 大小写与规范用户名不同的
    //   `@JohnDoe`）。两个用途：读的时候拿它把存量数据的 span 反推出来；以及老版本客户端
    //   就是拿它在正文里做子串匹配加链接的，删掉会让那些包直接不显示提及。
    //
    // ★ `offset`/`length` 是**这一次新加的**字段（正文里那个 `@` 的下标 / 名字长度，
    //   UTF-16 码元）。存量的提及行没有它们，读出来是 undefined —— 这是**全新字段**，
    //   缺失的真实含义就是"这行是老数据"，所以序列化处可以正向判断
    //   （`Number.isInteger(m.offset)`），不像 visibility 那种"缺失另有含义"的字段
    //   必须判否定。老行由 controller 用 token 在正文里反查补出 span。
    //
    // 存量评论整个没有 mentions 字段 → 读出来是 undefined。序列化处一律
    // `Array.isArray(x) ? x : []` 归一成空数组：对老评论而言"没有提及"就是事实。
    mentions: {
      type: [
        new mongoose.Schema(
          {
            user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
            token: { type: String, required: true, maxlength: 80 },
            // 刻意**不给 default**：0 是一个合法的 offset，给了 default 就分不出
            // "这行是老数据" 与 "这个 @ 就在正文开头"。
            offset: { type: Number, min: 0 },
            length: { type: Number, min: 1 },
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
