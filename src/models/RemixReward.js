// src/models/RemixReward.js
// 「同款奖励」的判定记录：**每条同款恰好一行**，写下这一条到期时判成了什么（发了 / 没发，为什么）。
// 规则与四个数在 config/remixReward.js，判定与发放的唯一实现在 services/remixReward.service.js。
//
// 它同时干三件事，所以没有借账本的 memo 现数（方案初稿那么写过）：
//   ① **恰好一次**：`remix` 唯一索引 —— 清扫器重跑、崩在一半、两个实例撞上，都只有一行能落下来，
//      发币的那一拍认的是「这一行是我刚占到的」。
//   ② **两道上限的计数**：每位原作者 24 小时内几次、每条原作一共几次，数的是这张表里 claimed + paid 的行。
//      数账本的话要拿正则去抠 memo，而且删号会把账本带走（下一条）。
//   ③ **审计**：「这条同款为什么没给奖励」逐条查得到 —— 没发的那些账本里一个字都没有。
//
// ★★ 删号时这张表**只删"他是原作者"的行**（branchAdmin.purgeUserCascade ⑦.9），"他是同款作者"的行**留着**：
//   那是别的原作者的上限计数。跟着同款作者一起删的话，刷子号做完同款就注销，原作者的两道上限就被悄悄清零了。
//   留下的只有几个 ObjectId（指向一个已经不存在的账号），够不成个人信息。删作品（purgeVideo）同理不动这张表。
const mongoose = require("mongoose");

// claimed  占到了、还没确认币进账（正常情况下只存在几十毫秒；停在这儿的由清扫器按账本补，见 service）
// paid     币进账了
// skipped  到期时判成不发，原因在 reason
const STATUSES = ["claimed", "paid", "skipped"];

// 不发的原因。★ 给人查的，不上屏（原作者只会收到"发了"的那条通知）；加新原因先加这里（mongoose enum，漏了会写入失败）
const SKIP_REASONS = [
  "disabled", // 开关关着
  "remix_not_public", // 同款到期时不是公开的（私密 / 凭链接可见 / 被下架）
  "original_not_public", // 原作没了 / 设成了私密 / 被下架（凭链接可见的原作算公开：工作流模板可以挂在那种作品上）
  "author_inactive", // 原作者注销 / 被封 / 账号不在了
  "remixer_inactive", // 同款作者注销 / 被封 / 账号不在了（封号不自动藏内容，所以要在这里挡）
  "self", // 自己按自己的流程做（发布那一拍就不该标成待判，这里是兜底）
  "repeat", // 同一个人对同一条原作已经算过一次
  "video_cap", // 这条原作到上限了
  "day_cap", // 这位原作者 24 小时内到上限了（不顺延）
];

const remixRewardSchema = new mongoose.Schema(
  {
    /** 那条同款作品。唯一：一条同款只判一次 */
    remix: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true },
    /** 被照着做的原作 */
    original: { type: mongoose.Schema.Types.ObjectId, ref: "BranchVideo", required: true },
    /** 原作者（收奖励的人） */
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** 同款作者（★ 只当事实记下来：他的钱包一个 token 都不动，见 config/remixReward 的 ★★） */
    remixer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: STATUSES, required: true },
    /** status === "skipped" 时的原因；其余为空串 */
    reason: { type: String, enum: ["", ...SKIP_REASONS], default: "" },
    /** 这一笔（要）发多少。skipped 为 0。记下来是因为那个数将来会改，而这一行说的是"当时发了多少" */
    tokens: { type: Number, default: 0 },
    /**
     * 判定的那一刻。★ 两道按时间算的规则（24 小时上限、占位多久算搁浅）都认它，**不认 createdAt**：
     *   createdAt 是 mongoose 按墙上时钟盖的，清扫器的 `now` 是传进来的（测试要拨时间），两个钟对不上。
     */
    decidedAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    /** 通知发出去了没有（发币与发通知是两步，崩在中间的由清扫器补那一条通知） */
    notifiedAt: { type: Date, default: null },
    /**
     * 这一行**还有事没办完**（占到了还没确认进账 / 进账了通知还没发）。办完就 $unset。
     * ★ 不给 default：只有 claimed 的行在创建时带它。清扫器靠下面那条 partial 索引只捞这些行 ——
     *   绝大多数行（paid 且已通知、skipped）不在索引里，表再大这一查也是空的。
     */
    open: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);

remixRewardSchema.index({ remix: 1 }, { unique: true });
// 每位原作者 24 小时内几次（author + status + decidedAt 范围）
remixRewardSchema.index({ author: 1, status: 1, decidedAt: -1 });
// 每条原作一共几次、同一个人算没算过（original + status [+ remixer]）
remixRewardSchema.index({ original: 1, status: 1, remixer: 1 });
// 清扫器「接着办」那一查。★ partialFilterExpression 写不了 `$exists:false`，所以用"在不在"而不是"为不为空"来表达没办完
remixRewardSchema.index({ decidedAt: 1 }, { partialFilterExpression: { open: true }, name: "remix_reward_open" });

module.exports = mongoose.model("RemixReward", remixRewardSchema);
module.exports.STATUSES = STATUSES;
module.exports.SKIP_REASONS = SKIP_REASONS;
