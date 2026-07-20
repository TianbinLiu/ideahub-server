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
  // ↓ 聊天/IM 类平台（sceneKind==="chat" 用）。它们由【聊天壳的皮肤注册表】渲染，不是评论皮肤；
  //   故 platformFromHost（贴 URL 抓评论）无需认它们，但 enum / 聊天皮肤 / 编辑器平台选项要有。
  "wechat",
  "qq",
];

// 场景类型 = 决定用哪个「壳/渲染器」。comment=评论区（默认，历史行为）；chat=聊天/私信/群聊（IM 时间线）。
// 新增 sceneKind 要同步：这里 + client 的聊天壳与皮肤注册表 + 编辑器 + AI 生成/扮演分支。
const SCENARIO_SCENE_KINDS = ["comment", "chat"];

// 用户面向的「分类」= 浏览/搜索/发布时选（与 sceneKind 正交：分类是话题领域，sceneKind 是版式）。
// 枚举外的值一律归 "other"。Phase 2 的模板市场按 category 浏览/筛选。
const SCENARIO_CATEGORIES = [
  "debate",    // 争论辩论（现有主场景）
  "workplace", // 职场办公
  "jobhunt",   // 求职应聘
  "social",    // 社交情感
  "service",   // 客服商家
  "fun",       // 娱乐整活
  "other",     // 其它
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

// 一等公民「参与者」花名册（chat 场景用；comment 场景可留空，沿用评论内联作者）。
// 让 AI 扮演有稳定身份/关系/目标的固定小卡司（你上司、HR、我…），比评论里那个 ≤200 字 stance 厚。
const scenarioParticipantSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, default: "", trim: true, maxlength: 80 },      // 显示名
    avatar: { type: String, default: "" },                                // 头像 url 或 emoji
    role: { type: String, default: "", trim: true, maxlength: 80 },       // 身份/关系：上司/HR/同事/我
    isSelf: { type: Boolean, default: false },                            // 是否代表「用户本人」（chat 我方气泡）
    goal: { type: String, default: "", trim: true, maxlength: 400 },      // 该角色目标/立场（供 AI 扮演）
    // 绑定的「人格」（Persona 广场里的可分享人格）。【引用语义】：只存 id，play 时实时取
    // 最新 styleDescriptor 喂 AI —— 人格作者更新风格会全网生效；人格被删/取消分享则回退到 goal。
    // personaName 是绑定时的名字快照，仅供编辑器/详情展示（人格不可用时也有东西可显示）。
    personaId: { type: String, default: "", trim: true },
    personaName: { type: String, default: "", trim: true, maxlength: 120 },
  },
  { _id: false }
);

// chat 场景的种子对话消息序列（相当于 comment 场景的 comments[]，只是线性、带发送者）。
// 注意：这与顶层 model ScenarioMessage（play 时真实用户的发言，做数据收集）不是一回事。
const scenarioChatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    senderId: { type: String, default: "", trim: true },                 // 指向 participants[].id
    text: { type: String, default: "", trim: true, maxlength: 2000 },
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
    // 场景类型 + 分类（都向后兼容：老情景无此字段 → sceneKind 默认 comment、category 默认 other）。
    sceneKind: { type: String, enum: SCENARIO_SCENE_KINDS, default: "comment", index: true },
    category: { type: String, default: "other", index: true },
    tags: { type: [String], default: [] },
    shared: { type: Boolean, default: false, index: true },
    sourceUrl: { type: String, default: "" },
    topic: { type: String, default: "", trim: true, maxlength: 2000 },
    comments: { type: [scenarioCommentSchema], default: [] },
    // chat 场景用（comment 场景留空）：固定卡司 + 种子对话。
    participants: { type: [scenarioParticipantSchema], default: [] },
    messages: { type: [scenarioChatMessageSchema], default: [] },
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
// Phase 2 模板市场按 分类 / 场景类型 浏览用。
scenarioSchema.index({ shared: 1, category: 1, createdAt: -1 });
scenarioSchema.index({ shared: 1, sceneKind: 1 });

module.exports = mongoose.model("Scenario", scenarioSchema);
module.exports.SCENARIO_PLATFORMS = SCENARIO_PLATFORMS;
module.exports.SCENARIO_SCENE_KINDS = SCENARIO_SCENE_KINDS;
module.exports.SCENARIO_CATEGORIES = SCENARIO_CATEGORIES;
