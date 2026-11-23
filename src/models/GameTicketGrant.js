// src/models/GameTicketGrant.js
// 「工坊游戏券」的发放 / 退回流水：一条 = 一次**幂等**的余额变动（发 monthly / share / invite / admin，退 refund）。
//
// 设计来源：app 仓 docs/g2-game-ui.md §7 第 2 条（"任务加券必须幂等 —— 没有唯一键，点两次分享领两次就是白送出一条片"）。
//
// ══ 为什么这张表就是那把锁 ════════════════════════════════════════════════════════
//   (userId, source, refId) 唯一索引。发券的顺序是「先抢唯一键、再动余额」：
//   抢不到 = 这一笔已经发过（重放 / 重复点 / 两个 pm2 实例同时到），直接返回 duplicate，一分不多发。
//   ★ 代价写在明处：抢到唯一键之后、$inc 余额之前进程崩掉，这一笔就**少发**了（下次同一 refId 是 duplicate，不补）。
//     方向是刻意的 —— 另一种顺序（先发后记）崩一次就是**多发**，而这里每多发一张都是真金白银的一段片。
//     与 tokenWallet / taskRefund 的取舍同源：宁可少发，不可多发（fail-closed）。
//
// ══ refId 怎么定（调用方负责，service 只要求非空）════════════════════════════════════
//   · monthly → 当月 "YYYY-MM"（一个月一个键 = 每月恰好发一次，跨月自然又是一笔）
//   · share / invite → 事件本身的 id（服务端落点产生的那一条记录），**不许**用日期或自增：
//     那样「同一天点两次分享」就变成两笔
//   · admin → 管理员自己给的 refId（不给则由 service 生成一个，意思就是「这次是故意的、不幂等」）
//   · refund → `${provider}:${taskId}`（与 taskRefund 的「恰好退一次」同一个键）
//
// ★ 这张表**没有 TTL**：删了就会允许同一个 refId 再发一次（等于把人已经领过的奖励重新变成可领）。
//   它也是「这个月发了多少张」的唯一事实来源（routes/gameTicket.routes 的管理员视图与对账都读它）。
const mongoose = require("mongoose");

const gameTicketGrantSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** monthly / share / invite / admin / refund（config/gameTicket.SOURCES 是唯一名单） */
    source: { type: String, required: true, maxlength: 16 },
    /** 幂等键（见文件头）。一个字都不能省：省了这张表就退化成流水，不再防重复 */
    refId: { type: String, required: true, maxlength: 120 },
    /**
     * grant = 凭空印（余额与 granted/earned 一起涨）/ refund = 失败退回（余额与 refunded 涨）。
     * ★ 判否定用不上它（有 source 就够），留着是为了对账时不用再看 source 名单。
     */
    kind: { type: String, enum: ["grant", "refund"], default: "grant" },
    /** 这一笔几张 */
    count: { type: Number, required: true, min: 1, max: 100 },
    /** 落在哪个月（"YYYY-MM"）：跨月退券时它与余额所在的那一行可能不是同一个月，对账要看 */
    cycle: { type: String, match: /^\d{4}-\d{2}$/, default: undefined },
    /** UTC 日（"YYYY-MM-DD"）：任务加券的日上限照它数 */
    day: { type: String, maxlength: 10, default: "" },
    /** 给人查的备注（管理员发的写明发给谁、退的写明哪一发任务） */
    memo: { type: String, default: "", maxlength: 200 },
    /**
     * 余额真的加上去了没有。抢到唯一键之后崩在 $inc 之前 → 这一位是 null（少发，不补，文件头 ★）。
     * ★ 不拿它做幂等判据（判据是唯一键）：它只回答「这一笔到底进没进账」，与 taskRefund 回读账本 memo 同形。
     */
    appliedAt: { type: Date, default: null },
    /** 谁发的（管理员端点）：只做追溯，不参与判定 */
    operator: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: undefined },
  },
  { timestamps: true, versionKey: false },
);

// ★★ 幂等的唯一实现（铁律六）：发 / 退都靠它抢。改这个索引等于改「能不能重复领」。
gameTicketGrantSchema.index({ userId: 1, source: 1, refId: 1 }, { unique: true });
// 任务加券的日上限（config/gameTicket.TASK_GRANTS_PER_DAY）：按 (人, 日, 来源) 数
gameTicketGrantSchema.index({ userId: 1, day: 1, source: 1 });
// 对账 / 客服查「这个人的券都是哪儿来的」
gameTicketGrantSchema.index({ userId: 1, createdAt: -1 });

const GameTicketGrant = mongoose.model("GameTicketGrant", gameTicketGrantSchema, "gameticketgrants");
module.exports = GameTicketGrant;
