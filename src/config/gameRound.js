// src/config/gameRound.js
// 「工坊对局」回合引擎的规则表与总开关（2026-11-23，G5 联机的第二块：每一回合交片 → 展映 → 点赞 → 投票 → 结算）。
//
// 设计正本在 app 仓：`docs/workshop-game-design.md` §2.0（五个阶段）、§2.5（两个榜 / 扣血 / 淘汰 / 胜者）、
// `docs/game-rules-engine.md` §5-8（扣血缩放：4 人 20/15/10/5、3 人 15/10/5、2 人 10/5）与
// `src/studio/game/rules.ts` 的 `damageForRank` / `winnerTargetOf`。
//
// ★★ 扣血公式与 App **逐字一致**（这是两仓最容易悄悄漂的一处，而漂了没有任何报错，只有「名次怪的」）：
//
//     base(rankFromLast) = rankFromLast < 3 ? [20, 15, 10][rankFromLast] : 5
//     damage            = max(5, floor(base × 人数 / 4 / 5) × 5)
//
//   rankFromLast：0 = 最后一名。人数 = **这一期参与结算的人数**（= 存活且有作品的人数）。
//   App 的 `damageForRank(playerCount, rankFromLast)` 是同一个式子；`tests/gameRound.spec.js` 里把
//   2 / 3 / 4 / 8 人的结果钉死（10/5、15/10/5、20/15/10/5、40/30/20 + 其余 10），两边改一处就会红。
//
// ★ 为什么数额是**代码常量**而不是环境变量：与 config/gameRoom / gameTicket 同一条纪律 ——
//   这是产品规则，改数要过代码评审；环境变量只放「过期多少分钟」这类运维旋钮。

/** 每个人的初始血量（§2.5）。回合引擎第一次结算时读成员的 hp，缺省 / 老房间没有这一位都按它算 */
const START_HP = 100;

/**
 * 扣血阶梯（从最后一名往前数）：最后一名 20、倒数第二 15、第三 10，其余 5。
 * ★ 顺序是「离最后一名多远」而不是名次：rankFromLast = 0 拿 20。
 */
const DAMAGE_LADDER = Object.freeze([20, 15, 10]);
const DAMAGE_OTHERS = 5;
/** 缩放的步长与地板：`floor(scaled / 5) * 5`，最低 5（人少时不至于 0 血） */
const DAMAGE_GRID = 5;

/**
 * 胜者名额：`min(2, 开局人数 − 1)`，至少 1。
 *
 * ★★ 为什么不照字面写「剩 ≤2 人」：自定义房间允许**两个人**开一局（config/gameRoom.MIN_PLAYERS_TO_START = 2）。
 *   照字面判，2 人局在**开局那一刻**就「剩 ≤2 人」= 第 1 回合结算完直接宣布两人都是胜者，
 *   这一局等于没打。App 的 `winnerTargetOf` 也是同一处切口（2 人局 1 个名额、4/8 人局 2 个），
 *   所以服务端按这个口径：**4/8 人局剩 2 人结束、2 人局剩 1 人结束**。
 */
function winnerTargetOf(playerCount) {
  const n = Math.max(1, Math.floor(Number(playerCount) || 0));
  return Math.max(1, Math.min(2, n - 1));
}

/**
 * 扣血（唯一实现）。与 App `rules.damageForRank` 同一个式子。
 * @param {number} playerCount 这一期参与结算的人数
 * @param {number} rankFromLast 0 = 最后一名
 */
function damageForRank(playerCount, rankFromLast) {
  const count = Math.max(0, Math.floor(Number(playerCount) || 0));
  const rank = Math.max(0, Math.floor(Number(rankFromLast) || 0));
  const base = rank < DAMAGE_LADDER.length ? DAMAGE_LADDER[rank] : DAMAGE_OTHERS;
  return Math.max(DAMAGE_GRID, Math.floor((base * count) / 4 / DAMAGE_GRID) * DAMAGE_GRID);
}

/** 回合的四个阶段（`settled` 之后只能 next） */
const PHASES = Object.freeze(["creating", "screening", "voting", "settled"]);

/**
 * 交片字段的上限。
 * ★ 提示词 80 字与 App 的 `PROMPT_BASE_MAX` 对齐：横屏真机那一栏只有一行半的宽度，
 *   再长就要滚动输入框（App 的 promptLimitOf 在事件加成时可能到 120 —— 服务端这里只挡
 *   「明显不是一句话」的输入，不替 App 算事件加成，否则事件那一格要在两仓各乘一遍）。
 */
const PROMPT_MAX = 80;
/** 一套卡面最多几张（4 角色 + 1 场景 + 装备，今天远不到 20；留一个防呆上限，不是产品口径） */
const CARD_NAMES_MAX = 20;
const CARD_NAME_MAX = 64;
/** 视频 / 封面地址上限：只挡把整段 base64 塞进来的输入，不校验主机（App 送的是 Cloudinary / 方舟地址） */
const URL_MAX = 2048;
const MODEL_TIER_MAX = 32;

/**
 * 总开关。缺省**开**；`GAME_ROUNDS=off` 急停（不用发版）。
 * ★ 关着的时候：`/api/game/rooms/:code/rounds*` 一律 503 `GAME_ROUNDS_OFF`；
 *   `/api/ark/health` 的 `gameRounds` 报 false（App 据此不摆「开始回合 / 展映 / 投票」这些按钮）。
 * ★ 每次现读环境变量（不在模块加载时定死）：测试要在同一个进程里开关它。
 */
function enabled() {
  return String(process.env.GAME_ROUNDS ?? "").trim().toLowerCase() !== "off";
}

module.exports = {
  START_HP,
  DAMAGE_LADDER,
  DAMAGE_OTHERS,
  DAMAGE_GRID,
  PHASES,
  PROMPT_MAX,
  CARD_NAMES_MAX,
  CARD_NAME_MAX,
  URL_MAX,
  MODEL_TIER_MAX,
  enabled,
  damageForRank,
  winnerTargetOf,
};
