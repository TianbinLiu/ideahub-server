/**
 * 跨仓价目一致性（tutor 仓 docs/06 §6.1「app 的 economy.ts 镜像 tutor_turn / distill / extract 三个价，与服务端 tokens.js 的一致性用例」）：
 * app 是**报价**（src/data/economy.ts 的 TUTOR_PRICES），这里是**结算**（config/tokens.js 的 TUTOR_PRICES），两边必须逐条相等 ——
 * 页面报 600、实际扣 800 用户就觉得被偷钱（app CLAUDE.md 坑表「两仓价目表各写各的」）。
 * ★ 为什么把 app 那份**抄**在这里而不是 fs 读 app 仓：与 arkProxy.spec 那几组同一个理由 —— server 独立部署，CI 里没有 app 的代码，
 *   「读不到就跳过」的用例是静默失败。改价时两边一起改、这里跟着改，三处任一没动这条就红。
 * 不碰 Mongo。
 */
const { TUTOR_PRICES, CHAT_TURN_TOKENS, priceOf } = require("../src/config/tokens");

// 抄自 app/src/data/economy.ts 的 TUTOR_PRICES（2026-09-29 M4）
const APP_TUTOR_PRICES = { tutor_turn: 400, tutor_distill: 600, tutor_extract: 400 };

describe("跨仓 tutor 价目一致性（app 报价 vs 服务端结算）", () => {
  test("三个价逐条相等，且没有第四个（app 多写一项 = 报了一个服务端不认的价）", () => {
    expect(APP_TUTOR_PRICES).toEqual({ ...TUTOR_PRICES });
    expect(Object.keys(APP_TUTOR_PRICES).sort()).toEqual(Object.keys(TUTOR_PRICES).sort());
  });
  test("tutor_turn 钉在 CHAT_TURN_TOKENS（app 里 TUTOR_PRICES.tutor_turn 也是从 CHAT_TURN_TOKENS 派生的，不是手写数字）", () => {
    expect(APP_TUTOR_PRICES.tutor_turn).toBe(CHAT_TURN_TOKENS);
    for (const [k, v] of Object.entries(APP_TUTOR_PRICES)) expect(priceOf(k)).toBe(v);
  });
});
