// src/config/remixReward.js
// 「同款奖励」的四个数与一个开关（模板体系 P3b，主人 2026-10-02 拍板；方案在 app 仓 docs/template-workflow-research.md §七 C）。
//
// 别人按你的流程做了同款、公开发布满 24 小时还公开着 → **平台**印一笔 token 给原作者。
//
// ★★ 这是**平台印钱**，不是同款作者付给原作者：token 只能购买、只能站内消耗，不许在用户之间流转
//   （撞微信支付「二清」的定义）。所以这笔钱没有对手方 —— 账本上只有原作者那一条 `remix_reward` 入账，
//   同款作者的钱包一个 token 都不动。哪天有人想把它改成"从同款作者那里扣"，先读这一段。
//
// ★ 这四个数是**产品口径**，由主人定；App 上那句「每次 N token、每天最多 M 次…」读的是
//   GET /api/branch/remix-reward 回的这一份（不在 App 里另抄一份 —— 两仓各写各的价目表栽过两次）。
//   改数只改这里。折算：15 元 / 百万 token ⇒ 一次 30k ≈ 0.45 元，一位作者一天封顶 ≈ 4.5 元，一条原作封顶 ≈ 22.5 元。

/** 每次奖励多少 token（≈ 一段极速档 5 秒） */
const TOKENS = 30_000;
/** 每位原作者在任意连续 24 小时内最多奖励几次。超出的**不顺延**（记成 skipped: day_cap），见 service 的 ★ */
const PER_AUTHOR_PER_DAY = 10;
/** 每条原作一共最多奖励几次 */
const PER_VIDEO = 50;
/** 同款发布满这么久、且那一刻还公开着，才判定发不发（发了就删的刷法一分钱拿不到） */
const HOLD_MS = 24 * 60 * 60 * 1000;

// ── 两道防刷（2026-10-03 主人点头加；数是我提的，要改只改这里）────────────────────────────
// 背景：注册不要验证码（每 IP 每小时 30 个），"小号互相做同款"刷得动。上面那两道上限管的是**收**奖励的一头
// （每个号每天 300k 封顶）；这两道管的是**刷**的一头与全站的总账。它们不是产品承诺、不上屏、不进 publicConfig：
// App 上那句话说的仍是那四个数，这两道只在有人刷的时候才咬得到人。

/**
 * 【防刷一】每个**同款作者**在任意连续 24 小时内最多给别人带来几次奖励（不顺延，记成 skipped: remixer_cap）。
 * ★ 为什么是 3：一条真同款要先花 token 炼出片子，正常人一天公开发三条以上别人的同款很少见；
 *   而对一圈互刷的小号，"每个号每天收到的"平均不可能超过"每个号每天带来的"，所以这道把互刷的日产量
 *   从 10 次 / 号压到 3 次 / 号（90k token ≈ 1.35 元），还得每天公开挂出三条垃圾作品满 24 小时（会被看见、被举报、被封）。
 */
const PER_REMIXER_PER_DAY = 3;

/**
 * 【防刷二】全站保险丝：任意连续 24 小时内**全站**最多发几次。到了就不发（skipped: budget），
 * 并在这个窗口里第一次断的时候给管理员发一封信（services/remixReward.service 的 alertFuse）。
 * ★ 缺省 100 次 = 一天最多印 300 万 token（≈ 45 元）。它不是用来限制正常增长的：真有那么多人在做同款是好事，
 *   收到那封信就把它调大 —— 所以它是**环境变量**（`REMIX_REWARD_GLOBAL_PER_DAY`，正整数；不设 / 写坏了都按缺省），不用发版。
 * ★ 断了之后那几条同款**不补发**（与两道上限同一条：判一次就定案）。
 */
const GLOBAL_PER_DAY_DEFAULT = 100;

function globalPerDay() {
  const n = Number(process.env.REMIX_REWARD_GLOBAL_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : GLOBAL_PER_DAY_DEFAULT;
}

/**
 * 总开关。缺省**开**；`REMIX_REWARD_ENABLED=false` 关掉（不用发版）。
 * ★ 关着的时候清扫器照跑，只是把到期的同款一律记成 skipped: disabled —— 不攒着：
 *   攒着的话重新打开那一刻会把关着期间的同款一口气全发出去，而那段时间我们什么都没承诺过。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return process.env.REMIX_REWARD_ENABLED !== "false";
}

/** 给 App 看的那一份（GET /api/branch/remix-reward）。键名是跨仓契约，改名要两边一起动 */
function publicConfig() {
  return {
    enabled: enabled(),
    tokens: TOKENS,
    perDay: PER_AUTHOR_PER_DAY,
    perVideo: PER_VIDEO,
    holdHours: Math.round(HOLD_MS / 3_600_000),
  };
}

module.exports = { TOKENS, PER_AUTHOR_PER_DAY, PER_VIDEO, HOLD_MS, PER_REMIXER_PER_DAY, GLOBAL_PER_DAY_DEFAULT, globalPerDay, enabled, publicConfig };
