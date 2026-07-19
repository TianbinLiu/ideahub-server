//User.js

const mongoose = require("mongoose");
const { SIGNUP_GRANT_POINTS } = require("../config/points");

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
    },

    avatarUrl: { type: String, default: "" },

    joinedGroupSlugs: { type: [String], default: [] },

    activeWorkshopTemplate: { type: mongoose.Schema.Types.ObjectId, ref: "WorkshopTemplate", default: null },
    siteComponents: { type: siteComponentsSchema, default: () => ({}) },

    // ✅ 以后你做“邮箱必须验证码验证后才能登录”会用到
    emailVerified: { type: Boolean, default: false },

    // ✅ 账号注销（软删除）：只打时间戳标记，不删任何内容数据，可恢复。
    // null = 正常账号；有值 = 已注销，auth 中间件一律视为未授权。
    deactivatedAt: { type: Date, default: null },

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
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

module.exports = mongoose.model("User", userSchema);
