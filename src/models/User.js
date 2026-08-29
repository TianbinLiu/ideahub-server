//User.js

const mongoose = require("mongoose");
const { SIGNUP_GRANT_POINTS } = require("../config/points");
// 大小写不敏感索引的 collation 与查询侧同源，别再手抄字面量（见 utils/username.js）
const { CI_COLLATION } = require("../utils/username");

const live2dComponentSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    source: { type: String, enum: ["remote", "uploaded"], default: "remote" },
    modelJsonUrl: { type: String, default: "" },
    uploadedModelJsonUrl: { type: String, default: "" },
    uploadedBundleName: { type: String, default: "" },
  },
  { _id: false }
);

const simpleToggleComponentSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const siteComponentsSchema = new mongoose.Schema(
  {
    live2d: { type: live2dComponentSettingsSchema, default: () => ({}) },
    tagRank: { type: simpleToggleComponentSchema, default: () => ({}) },
    siteTemplateEditor: { type: simpleToggleComponentSchema, default: () => ({}) },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, unique: true },
    email: { type: String, required: true, trim: true, unique: true },

    passwordHash: { type: String, default: "" },
  tokenVersion: { type: Number, default: 0 },

    role: { type: String, enum: ["user", "company", "admin"], default: "user" },
    displayName: { type: String, default: "" },
    bio: { type: String, default: "" },

    // ✅ OAuth providers
    providers: {
      google: { type: String, default: "" }, // google sub
      github: { type: String, default: "" }, // github id
      // QQ 的 openid。★ 它是**按应用隔离**的：同一个 QQ 号在不同 AppID 下 openid 不同，
      //   所以换 AppID 等于所有 QQ 用户失联 —— 换之前先想清楚怎么迁移。
      //   （跨应用认同一个人要用 unionid，那需要额外申请，我们没开。）
      qq: { type: String, default: "" },
      // 微信：unionid 优先、openid 兜底（wechatOauth.service 文件头有取舍说明）
      wechat: { type: String, default: "" },
    },

    avatarUrl: { type: String, default: "" },

    // 用户协议同意记录（2026-08-28 App 侧上线协议链路时加）。
    // ★ 服务端只存不判：值是 App 端 data/agreements 的 TERMS_UPDATED（形如 "2026-08-28"），
    //   "要不要重新弹"由客户端拿它对自己当前的版本；这里是合规留痕（谁、哪版、何时）。
    //   缺省空串 = 没同意过（存量用户），客户端会视为需要补签——判否定，别判相等。
    termsAcceptedVersion: { type: String, default: "" },
    termsAcceptedAt: { type: Date, default: null },

    joinedGroupSlugs: { type: [String], default: [] },

    activeWorkshopTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "WorkshopTemplate", default: null },
    siteComponents: { type: siteComponentsSchema, default: () => ({}) },

    // ✅ 以后你做“邮箱必须验证码验证后才能登录”会用到
    emailVerified: { type: Boolean, default: false },

    // ✅ 手机号登录（短信验证码）。
    // ★ sparse+unique：既有用户【没有】这个字段，sparse 索引会跳过它们、不参与唯一性冲突；
    //   只有手机登录/绑定过的用户才写入。故【绝不能】给 default（默认 "" 会让所有老用户都拿到 ""
    //   而互相冲突）——保持 undefined，sparse 才生效。存归一化后的 11 位大陆手机号。
    phone: { type: String, unique: true, sparse: true, trim: true },
    phoneVerified: { type: Boolean, default: false },

    // ✅ 账号注销（软删除）：只打时间戳标记，不删任何内容数据，可恢复。
    // null = 正常账号；有值 = 已注销，auth 中间件一律视为未授权。
    deactivatedAt: { type: Date, default: null },

    // ✅ 平台封禁（管理员的开关，与 deactivatedAt 那把「用户自己的开关」是两回事）。
    // **没有这个键 = 没封**（与 BranchVideo.takedown 同一种给法：$set 整个子文档 = 封，
    // $unset = 解封；判据走 `banned.at` 的 dot 路径，绝不 $set null —— 理由见
    // branchVideo.controller 的 TAKEN_DOWN：写成 null 的坏数据该往「没封」方向倒）。
    //
    // ★ 封禁挡的是**登录与一切带 token 的请求**（signToken 拒签 + requireAuth 拦截，
    //   403 + 可读原因），**不**自动隐藏其内容 —— 内容处置走每条内容自己的下架/删除。
    //   两权分开是刻意的：封人是「这个人不能再进来」，下架是「这条内容不能再被看到」，
    //   合成一个开关的话，解封一个改好了的人会连带把他真正违规的那几条一起放出来，
    //   反之封人时全量藏内容又会把他没问题的作品也一起消失（对看过的人毫无解释）。
    // ★ 刻意不给 default：给了 default（哪怕 null）每个新用户都会带着这个键落库，
    //   「有没有这个键」就不再是判据本身（与 tokenWallet 不给 default 同一条理由）。
    banned: {
      type: new mongoose.Schema(
        {
          /** 谁封的。只进库与日志，**永不**透给被封的用户（与 takedown.by 同一条理由） */
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          at: { type: Date, required: true },
          /** 给用户看的原因。必填 —— 「你被封了但不告诉你为什么」只会引来重复注册 */
          reason: { type: String, default: "", maxlength: 500 },
        },
        { _id: false },
      ),
      required: false,
    },

    // ✅ 虚拟点数余额。★不是真钱：无现金价值，不可提现/兑换，不接任何真实支付。
    //
    // 新用户的这 1000 点就是「注册赠送」本身（default 直接给足），
    // 注册路径随后补一条 reason="signup" 的账本分录把它记进账 —— 见 services/points.service.js。
    // 所以【绝不能】把 default 改成别的数而不动 SIGNUP_GRANT_POINTS，否则余额和账本对不上。
    //
    // ★既有用户没有这个字段。必须跑 `npm run backfill:points` 补齐，
    //   【不要】在运行时用 (user.points ?? 1000) 兜底：那会让「余额」在 backfill 前后含义不同，
    //   而且和账本对不上。缺字段的账号在写入侧（{points:{$gte:X}} 条件更新）本来就匹配不到，
    //   读出侧也必须保持同一口径（见 me.controller 的 getMyPoints）。
    points: { type: Number, default: SIGNUP_GRANT_POINTS, min: 0 },

    // ✅ AI token 钱包。★与上面的 points 是**两套完全不同的东西**，别混：
    //   points 是用户之间转移的平台虚拟点数（复式记账、和为零）；
    //   tokenWallet 是**对外采购的算力额度**——花在火山方舟上，没有对手方。
    //
    // 这个钱包以前长在客户端（app 仓 data/account.ts 的 IndexedDB）。那等于把收银台
    // 交给顾客：改一行前端就能把余额写成无限，而每次方舟调用都是真金白银。
    //
    // ★ 刻意**不给 default**：有没有这个字段是"要不要初始化"的判据本身
    //   （tokenWallet.service 的 ensureWallet 用 {$exists:false} 做条件原子更新抢占初始化，
    //   并补一条 reason="grant" 的流水）。给了 default，老账号读出来就凭空有了余额、
    //   却没有对应的流水，账本和余额从第一天起就对不上。
    //   plan = 当月套餐额度（跨月刷新，未用完的作废）；addon = 直充/退款（永不过期）。
    tokenWallet: {
      type: new mongoose.Schema(
        {
          plan: { type: Number, required: true, min: 0 },
          addon: { type: Number, required: true, min: 0 },
          planId: { type: String, default: "free" },
          /** 计费周期 "YYYY-MM"（UTC）。跨月刷新靠它做条件原子更新抢占 */
          cycle: { type: String, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

// ★ @提及查询专用的**大小写不敏感**索引，与 utils/username.js 的 CI_COLLATION
//   必须逐字相等 —— MongoDB 只在查询 collation 与索引 collation 完全一致时才用得上它，
//   对不上不会报错，只是默默退化成全表扫（users 表迟早会大到让每条评论都拖一下）。
//   所以这里直接引那个常量，不再手抄一份 `{locale:"en",strength:2}`。
//
//   ★★ 这条索引现在**同时承担唯一性**（2026-08-13 改）：原来 `username_1` 是 unique
//   但**不带 collation**，于是 "tianbinliu" 和 "TianbinLiu" 可以同时存在 ——
//   而 username 是本 app 公开的 @ 句柄，换个大小写注册一个就能冒充别人，
//   注册那侧的查重（auth.controller）当时也没带 collation，两道关一起漏。
//   2026-08-13 在生产库上确认过：26 个用户，忽略大小写后**没有任何重复**，
//   所以现在收紧是安全的（有存量冲突的话建索引会当场失败、启动即挂，那属于要先清人的情况）。
//
//   ⚠ **改这行不会自动生效**：mongoose 只创建"缺失"的索引，**从不修改已存在索引的选项**，
//   而 `username_ci` 已经以非唯一形态存在于生产库。要真正落地必须先删再建：
//     db.users.dropIndex("username_ci")
//   然后重启服务让 autoIndex 重建（或手动 createIndex 带上同样的 name/collation/unique）。
//   删掉到重建之间有一个"唯一性不生效"的窗口，只有几秒，但要知道它存在。
//
//   为什么不去动 `username_1`：那条是 mongoose 从 `unique: true` 自动建的，
//   动它要连 schema 一起改，而两条 unique 索引（一条区分大小写、一条不区分）
//   同时存在是合法的，后者更严，前者自然就成了它的子集。少动一处是一处。
userSchema.index({ username: 1 }, { name: "username_ci", collation: CI_COLLATION, unique: true });

// ★ displayName 的同款索引，服务的是**找人搜索里的"精确档"**
//   （users.controller 的 searchUsers 单独发的那条等值查询）。
//   没有它的话，那条查询的 $or 里有一个分支用不上索引 —— 而 MongoDB 的 $or
//   是"任一分支无索引则整条退化成集合扫"，等于为了修排序问题白白多加一次全表扫。
//   非唯一：displayName 本来就允许重名（它不是身份，username 才是）。
userSchema.index({ displayName: 1 }, { name: "displayName_ci", collation: CI_COLLATION });

module.exports = mongoose.model("User", userSchema);
