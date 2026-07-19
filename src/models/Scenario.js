const mongoose = require("mongoose");

// 情景模拟支持的平台枚举 —— 这是【全站唯一的平台真源】：
// controllers/scenario.controller.js 的 normalizePlatform 直接读它，枚举外的值一律
// 【静默降级为 generic】（不报错，皮肤跟着退化成通用皮肤）。
//
// ⚠️ 「静默降级」意味着：只要一个平台没进这个数组，插件抓到它、用户选了它，都会悄悄变成 generic。
//    所以新增平台必须【四处同改】，缺任何一处都只是徒增枚举：
//      1. 这里（否则后端吞掉）
//      2. client/src/components/skins/index.ts 加专属皮肤（否则前端 fallback 到 GenericSkin）
//      3. client/src/pages/ScenarioEditorPage.tsx 的 PLATFORM_OPTIONS（否则用户选不到）
//      4. controllers/scenario.controller.js 的 platformFromHost（否则贴 URL 抓取时认不出域名）
//
// ⚠️ 本次【故意不加】 twitter / youtube / reddit：插件的 detectPlatform 认得它们，但本次
//    没有为它们做皮肤 —— 只加枚举不做皮肤，结果仍然是 fallback 到 GenericSkin，
//    平台名从「被后端吞掉」变成「被前端吞掉」，问题没解决还多了三个枚举值。
//    等哪天为它们写了皮肤，再连同上面 4 处一起加。
const SCENARIO_PLATFORMS = [
  "bilibili",
  "weibo",
  "tieba",
  "zhihu",
  "instagram",
  "douyin",
  "xiaohongshu",
  "generic",
];

const scenarioCommentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    authorName: { type: String, required: true, trim: true, maxlength: 80 },
    authorAvatar: { type: String, default: "" },
    text: { type: String, default: "", trim: true, maxlength: 2000 },
    likeCount: { type: Number, default: 0 },
    parentId: { type: String, default: null },
    isOP: { type: Boolean, default: false },
    stance: { type: String, default: "", trim: true, maxlength: 200 },
  },
  { _id: false }
);

const scenarioSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    summary: { type: String, default: "", trim: true, maxlength: 500 },
    coverImageUrl: { type: String, default: "" },
    platform: { type: String, enum: SCENARIO_PLATFORMS, default: "generic", index: true },
    tags: { type: [String], default: [] },
    shared: { type: Boolean, default: false, index: true },
    sourceUrl: { type: String, default: "" },
    topic: { type: String, default: "", trim: true, maxlength: 2000 },
    comments: { type: [scenarioCommentSchema], default: [] },
    stats: {
      viewCount: { type: Number, default: 0 },
      likeCount: { type: Number, default: 0 },
      bookmarkCount: { type: Number, default: 0 },
      playCount: { type: Number, default: 0 },
      _id: false,
    },
  },
  { timestamps: true }
);

scenarioSchema.index({ shared: 1, createdAt: -1 });
scenarioSchema.index({ shared: 1, "stats.likeCount": -1 });

module.exports = mongoose.model("Scenario", scenarioSchema);
module.exports.SCENARIO_PLATFORMS = SCENARIO_PLATFORMS;
