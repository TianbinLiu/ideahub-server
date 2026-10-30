// src/models/TemplateReward.js
// 「模板作者奖励」的判定记录：**每个 (作品, 模板) 恰好一行**，写下这一对到期时判成了什么（发了 / 没发，为什么）。
// 规则与几个数在 config/templateReward.js，判定与发放的唯一实现在 services/templateReward.service.js。
// 形状照抄 models/RemixReward.js（那边的 ★★ 全部适用），只是主键从「一条同款」换成「一条作品 × 一个模板」：
// 一条作品用了几个不同的模板就各判一次、各自占位。
//
// 它同时干三件事（与 RemixReward 同一段理由，这里只记差异）：
//   ① **恰好一次**：`{ video, template }` 唯一索引 —— 清扫器重跑、崩在一半、两个实例撞上，都只有一行能落下来；
//      回炉换内容再带一遍同一个模板 id 也落不下第二行（契约：已经判过的 (作品, 模板) 不再判）。
//   ② **三道上限的计数**：每位模板作者 24 小时内几次、每个模板一共几次、每个使用者 24 小时内带来几次，数的都是这张表里 claimed + paid 的行。
//   ③ **审计**：「这一对为什么没给奖励」逐条查得到。
//
// ★★ 删号时这张表**只删"他是模板作者"的行**（branchAdmin.purgeUserCascade ⑦.9），"他是使用者"的行**留着**：
//   那是别的模板作者的上限计数。删模板（DELETE /templates/:id）与删作品（purgeVideo）同理不动这张表。
const mongoose = require("mongoose");

// claimed  占到了、还没确认币进账（正常情况下只存在几十毫秒；停在这儿的由清扫器按账本补，见 service）
// paid     币进账了
// skipped  到期时判成不发，原因在 reason
const STATUSES = ["claimed", "paid", "skipped"];

// 不发的原因。★ 给人查的，不上屏（模板作者只会收到"发了"的那条通知）；加新原因先加这里（mongoose enum，漏了会写入失败）
const SKIP_REASONS = [
  "disabled", // 开关关着
  "video_not_public", // 作品到期时不是公开的（私密 / 凭链接可见 / 被下架）
  "template_gone", // 模板已经不在了（作者删了）
  "template_blocked", // 模板被平台下架（blocked）：被下架的东西不该还在给作者印钱
  "author_inactive", // 模板作者注销 / 被封 / 账号不在了
  "user_inactive", // 套模板的人注销 / 被封 / 账号不在了（封号不自动藏内容，所以要在这里挡）
  "self", // 自己套自己的模板（判定时才排除，不在写入时排除：写入时只认 id 在不在）
  "blocked", // 两人之间有拉黑（任一方向）。★ 与同款奖励不同：那边币照发、只是通知匿名；这边规则写明「没有拉黑才发」
  "user_cap", // 这位**使用者** 24 小时内带来的奖励到上限了（防刷一，config/templateReward 的 PER_USER_PER_DAY）
  "template_cap", // 这个模板到上限了
  "day_cap", // 这位模板作者 24 小时内到上限了（不顺延）
  "budget", // 全站保险丝断了（防刷二，config/templateReward 的 globalPerDay）—— 这一条本来是该发的
];

const templateRewardSchema = new mongoose.Schema(
  {
    /** 套了模板的那条作品 */
    video: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true },
    /** 被套用的模板 */
    template: { type: mongoose.Schema.Types.ObjectId, ref: "BranchTemplate", required: true },
    /** 模板作者（收奖励的人）= 判定那一刻的 BranchTemplate.ownerId */
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** 套模板的人 = BranchVideo.author（★ 只当事实记下来：他的钱包一个 token 都不动，见 config/templateReward 的 ★★） */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: STATUSES, required: true },
    /** status === "skipped" 时的原因；其余为空串 */
    reason: { type: String, enum: ["", ...SKIP_REASONS], default: "" },
    /** 这一笔（要）发多少。skipped 为 0。记下来是因为那个数将来会改，而这一行说的是"当时发了多少" */
    tokens: { type: Number, default: 0 },
    /**
     * 判定的那一刻。★ 三道按时间算的规则（24 小时上限 ×2、占位多久算搁浅）都认它，**不认 createdAt**：
     *   createdAt 是 mongoose 按墙上时钟盖的，清扫器的 `now` 是传进来的（测试要拨时间），两个钟对不上。
     */
    decidedAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    /** 通知发出去了没有（发币与发通知是两步，崩在中间的由清扫器补那一条通知） */
    notifiedAt: { type: Date, default: null },
    /**
     * 这一行**还有事没办完**（占到了还没确认进账 / 进账了通知还没发）。办完就 $unset。
     * ★ 不给 default：只有 claimed 的行在创建时带它。清扫器靠下面那条 partial 索引只捞这些行。
     */
    open: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);

templateRewardSchema.index({ video: 1, template: 1 }, { unique: true });
// 每位模板作者 24 小时内几次（author + status + decidedAt 范围）
templateRewardSchema.index({ author: 1, status: 1, decidedAt: -1 });
// 每个模板一共几次（template + status）
templateRewardSchema.index({ template: 1, status: 1 });
// 防刷一：这位使用者 24 小时内带来了几次（user + status + decidedAt 范围）
templateRewardSchema.index({ user: 1, status: 1, decidedAt: -1 });
// 防刷二：全站 24 小时内发了几次（status + decidedAt 范围）
templateRewardSchema.index({ status: 1, decidedAt: -1 });
// 清扫器「接着办」那一查。★ partialFilterExpression 写不了 `$exists:false`，所以用"在不在"而不是"为不为空"来表达没办完
templateRewardSchema.index({ decidedAt: 1 }, { partialFilterExpression: { open: true }, name: "template_reward_open" });

module.exports = mongoose.model("TemplateReward", templateRewardSchema);
module.exports.STATUSES = STATUSES;
module.exports.SKIP_REASONS = SKIP_REASONS;
