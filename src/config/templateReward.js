// src/config/templateReward.js
// 「模板作者奖励」的几个数与一个开关（主人 2026-10-30 拍板；设计正本在 app 仓 docs/template-author-reward-design.md）。
//
// 别人套用了你的模板出片、公开发布满 24 小时还公开着 → **平台**印一笔 token 给模板作者。
// 形状**照抄**同款奖励（config/remixReward.js）：只换触发源（作品 → 它套过的模板）与几个数。
//
// ★★ 这是**平台印钱**，不是套模板的人付给模板作者：token 只能购买、只能站内消耗，不许在用户之间流转
//   （撞微信支付「二清」的定义，与 remixReward 的 ★★ 同一句）。账本上只有模板作者那一条 `template_reward` 入账，
//   套模板的人的钱包一个 token 都不动。
//
// ★ 这几个数是**产品口径**，由主人定；App 上那句「每次 N token、每天最多 M 次…」读的是
//   GET /api/branch/template-reward 回的这一份（不在 App 里另抄一份 —— 两仓各写各的价目表栽过两次）。
//   改数只改这里。折算：15 元 / 百万 token ⇒ 一次 10k ≈ 0.15 元，一位作者一天封顶 ≈ 3 元，一个模板封顶 ≈ 30 元。

/** 每次奖励多少 token。★ 同款是 30k：套模板比照着流程做同款轻得多、频次高得多，所以是它的三分之一 */
const TOKENS = 10_000;
/** 每位模板作者在任意连续 24 小时内最多奖励几次。超出的**不顺延**（记成 skipped: day_cap），见 service 的 ★ */
const PER_AUTHOR_PER_DAY = 20;
/** 每个模板一共最多奖励几次 */
const PER_TEMPLATE = 200;
/** 作品发布满这么久、且那一刻还公开着，才判定发不发（发了就删的刷法一分钱拿不到） */
const HOLD_MS = 24 * 60 * 60 * 1000;

// ── 两道防刷（与同款奖励的 PER_REMIXER_PER_DAY / globalPerDay 同一个理由）─────────────────
// 上面那两道上限管的是**收**奖励的一头；这两道管的是**刷**的一头与全站的总账。
// 它们不是产品承诺、不上屏、不进 publicConfig 的前四位之外 —— 唯独 perUserPerDay 进（契约那一行列了它，
// App 要能说「你一天最多给别人带来 3 次」）。

/**
 * 【防刷一】每个**使用者**（套模板出片的人）在任意连续 24 小时内最多给别人带来几次奖励（不顺延，记成 skipped: user_cap）。
 * ★ 为什么是 3：与同款奖励的 PER_REMIXER_PER_DAY 同一个数、同一个理由 —— 对一圈互刷的小号，
 *   "每个号每天收到的"平均不可能超过"每个号每天带来的"，这道把互刷的日产量压到 3 次 / 号（30k token ≈ 0.45 元），
 *   还得每天公开挂出三条作品满 24 小时（会被看见、被举报、被封）。
 */
const PER_USER_PER_DAY = 3;

/**
 * 【防刷二】全站保险丝：任意连续 24 小时内**全站**最多发几次。到了就不发（skipped: budget），
 * 并在这个窗口里第一次断的时候给管理员发一封信（services/templateReward.service 的 alertFuse）。
 * ★ 缺省 200 次 = 一天最多印 200 万 token（≈ 30 元）。同款是 100 次：模板奖励单价是它的三分之一、预期频次更高。
 *   它不是用来限制正常增长的：真有那么多人在套模板是好事，收到那封信就把它调大 —— 所以它是**环境变量**
 *   （`TEMPLATE_REWARD_GLOBAL_PER_DAY`，正整数；不设 / 写坏了都按缺省），不用发版。
 * ★ 断了之后那几条**不补发**（与两道上限同一条：判一次就定案）。
 */
const GLOBAL_PER_DAY_DEFAULT = 200;

function globalPerDay() {
  const n = Number(process.env.TEMPLATE_REWARD_GLOBAL_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : GLOBAL_PER_DAY_DEFAULT;
}

/**
 * 总开关。缺省**开**；`TEMPLATE_REWARD_ENABLED=false` 关掉（不用发版）。
 * ★ 关着的时候清扫器照跑，只是把到期的一律记成 skipped: disabled —— 不攒着：
 *   攒着的话重新打开那一刻会把关着期间的一口气全发出去，而那段时间我们什么都没承诺过。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return process.env.TEMPLATE_REWARD_ENABLED !== "false";
}

/**
 * 给 App 看的那一份（GET /api/branch/template-reward）。键名是跨仓契约（app 仓 docs/api-contract.md「模板作者奖励」），改名要两边一起动。
 * ★ `holdMs` 给毫秒（同款那边给的是 holdHours）：契约就是这么写的，App 的 `data/templateReward` 照它读。
 */
function publicConfig() {
  return {
    enabled: enabled(),
    tokens: TOKENS,
    perAuthorPerDay: PER_AUTHOR_PER_DAY,
    perTemplate: PER_TEMPLATE,
    perUserPerDay: PER_USER_PER_DAY,
    holdMs: HOLD_MS,
  };
}

module.exports = { TOKENS, PER_AUTHOR_PER_DAY, PER_TEMPLATE, HOLD_MS, PER_USER_PER_DAY, GLOBAL_PER_DAY_DEFAULT, globalPerDay, enabled, publicConfig };
