// src/config/gameTicket.js
// 「工坊游戏券」（GameTicket）的规则表与总开关。
//
// 设计来源（app 仓，两个都是**产品口径**、不是我定的）：docs/g4-ui-revamp-spec.md §0
//   「免费套餐每月 6 张游戏券（按月算，不是每天）＝每月能真出 6 条片；另外任务加券：分享 App、邀请新用户等；
//     券只用于游戏内出片，不扣 token 钱包；券用完这一局就用占位片打完」
// 与 docs/g2-game-ui.md §7「改造清单（9 条）」。
//
// ★★ 券与 token **不可互换**（不做汇率、不可购买、不可转让）：照 config/remixReward.js / templateReward 的
//   「平台印钱」口径，只是这次印的是券。所以这里**没有**、也不许出现「券换 token / token 换券」的函数，
//   账本（TokenLedger）里也一个字都不记券 —— 券的每一次进出都在 GameTicketGrant 那张表上。
//
// ★ 为什么月刷新**没有定时任务**：与钱包的 `cycle` 同一个套路 —— 靠「跨月第一次触达」时用唯一索引抢占
//   （GameTicketGrant 的 (userId, source, refId)，refId 就是 "YYYY-MM"）。定时任务要多实例判断、要补跑、
//   还会在没人登录的月份白给一堆空行；懒发则「读一次余额 = 到账」，与 GET /api/me/wallet 同一个形状。
//   唯一代价：**这个月没打开过对局的人，到月底那张券没有落库** —— 而它本来就当月有效、过期作废，没有损失。
//
// ★ 数额（6 张）是主人拍板的免费套餐口径；付费套餐要不要多发、券能不能滚存，**都还没拍板**
//   （app 仓 g2-game-ui.md §8「券与免费档门禁的最终口径要主人拍板」）。今天一视同仁：谁都是每月 6 张。

/** 每月发几张（免费套餐口径，主人 2026-11-23 拍板；付费套餐是否另算**未拍板**，今天一视同仁） */
const MONTHLY_TICKETS = 6;

/**
 * 一次出片花几张。★ 恒为 1、**不做环境变量**：一处出片一张券是产品口径（每月 6 张 = 每月 6 条片），
 * 而做成可配之后「几条片 = 几张券」会散在 App 的报价与这里两处，两边对不上时用户看到的是「扣了两张」。
 */
const TICKETS_PER_GENERATION = 1;

/**
 * 单次 grant 最多发几张（管理员端点用）。防的是「参数写错多打一个零」，
 * 不是防管理员 —— 管理员能发券这件事本身已经是最高的信任了。
 */
const MAX_GRANT_PER_CALL = 10;

/**
 * 券的来源。前四种是**能凭空印的**（GRANT_SOURCES），最后一种 `refund` 是**失败退回**：
 * 它同样记在 GameTicketGrant 上，但只把余额加回去、不计进「这个月发了多少」。
 * ★ 为什么退款也要一张记录：受理之后才失败的那一发，退款是**异步**的（清扫器 / 轮询），
 *   与钱包那条路一样要「恰好退一次」（tokenWallet 文件头 W2 的 ★★）——
 *   唯一键 (userId, source, refId) 用 `(refund, provider:taskId)` 就当那把锁，进程崩溃续办时重放是幂等的。
 */
const SOURCES = Object.freeze(["monthly", "share", "invite", "admin", "refund"]);
/** 能凭空印的几种（refund 不在里面：它退的是已经扣掉的，不增加「发了多少」） */
const GRANT_SOURCES = Object.freeze(["monthly", "share", "invite", "admin"]);

/**
 * 【防刷】每个账号每个 UTC 日，靠**任务事件**（share / invite）最多领几张。
 * ★ 数额主人还没定（g2-game-ui.md §7 第 9 条：「分享 App / 邀请新用户」今天还没有服务端落点）。
 *   这一道是**占位**的防刷闸，不是产品承诺：等真的接上事件源时按实际情况调，但**不能删** ——
 *   删了等于「点两次分享领两次」，白送出去的就是真金白银的出片。
 * ★ 只管 share / invite；monthly / admin 不受它管（前者一个月一次、后者是人手动发的）。
 * ★ 不是环境变量：这是防刷边界，放宽要过代码评审（同 config/tokens.MINIMAX_V2_FREE_TEXT_ONLY 的口径）。
 */
const TASK_GRANTS_PER_DAY = 5;

/**
 * 总开关。缺省**开**；`GAME_TICKETS=off` 关掉（不用发版）。
 * ★ 关着的时候：出片请求带券标记直接 403 `GAME_TICKETS_OFF`（**不悄悄改走 token 结算** ——
 *   用户点了「用一张券」，我们不能在不说的前提下扣他的钱）；`GET /api/game/tickets` 照常回余额
 *   （读是安全的），`/api/ark/health` 的 `gameTickets` 报 false，App 据此不再发券标记。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return String(process.env.GAME_TICKETS ?? "").trim().toLowerCase() !== "off";
}

/** 给 App 看的那一份（/api/ark/health 的能力位；键名是跨仓契约，改名要两边一起动） */
function publicConfig() {
  return {
    enabled: enabled(),
    monthly: MONTHLY_TICKETS,
    perGeneration: TICKETS_PER_GENERATION,
    taskGrantsPerDay: TASK_GRANTS_PER_DAY,
    sources: GRANT_SOURCES.slice(),
  };
}

module.exports = {
  MONTHLY_TICKETS,
  TICKETS_PER_GENERATION,
  MAX_GRANT_PER_CALL,
  SOURCES,
  GRANT_SOURCES,
  TASK_GRANTS_PER_DAY,
  enabled,
  publicConfig,
};
