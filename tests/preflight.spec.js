// 生产配置自检的判据测试。
//
// ★ 为什么值得有这一份：preflight 的全部价值是「配错了就起不来」。它自己错了的话，
//   症状恰恰是**什么都不报**——服务照常启动，而错配一直在生产上跑着。
// ★ 只测 collectConfigProblems（纯函数、收问题清单）：assertProductionConfig 会 process.exit(1)，
//   在 jest 里跑它等于把 worker 打死。
const { collectConfigProblems } = require("../src/config/preflight");

/** 一份「生产上完全合规」的底座：任何一条测试只改它一个字段，问题清单就该只多那一条 */
function prodBase(extra = {}) {
  return {
    NODE_ENV: "production",
    JWT_SECRET: "x".repeat(40),
    OTP_PEPPER: "a-real-pepper",
    SMS_PROVIDER: "aliyun",
    CORS_ORIGINS: "https://qimeng.example",
    ...extra,
  };
}

const runwayProblems = (env) => collectConfigProblems(env).problems.filter((p) => p.includes("RUNWAY"));

describe("生产配置自检 · Runway 未接计费就不许在生产开出网", () => {
  // ★★ 这条闸的由来：runway.routes.js 至今是**纯代理**（两处 fetch 直连上游，一次扣费调用都没有，
  //   对照方舟那条走的是 billedForward）。生产配上这把钥匙 = 任何拿得到我们 token 的人都能
  //   无计量地烧钱、而账上一分不记。以前这只是 backlog 与 .env.example 里的一句警告 ——
  //   2026-09-03 钉成硬闸。
  test("生产没配 RUNWAY_API_KEY：不报这一条", () => {
    expect(runwayProblems(prodBase())).toHaveLength(0);
  });

  test("生产配了 RUNWAY_API_KEY：报出来（生产会因此拒绝启动）", () => {
    const problems = runwayProblems(prodBase({ RUNWAY_API_KEY: "rw_live_xxx" }));
    expect(problems).toHaveLength(1);
    // 话要说清"为什么不许"与"什么时候可以"，不能只写一句"不许配"
    expect(problems[0]).toMatch(/计费/);
  });

  test("非生产配了 RUNWAY_API_KEY：**不拦**（开发要能拿它调通上游）", () => {
    expect(runwayProblems({ NODE_ENV: "development", RUNWAY_API_KEY: "rw_dev_xxx" })).toHaveLength(0);
  });

  test("空串不算配（漏值的 .env 行不该把生产拦在门外）", () => {
    expect(runwayProblems(prodBase({ RUNWAY_API_KEY: "" }))).toHaveLength(0);
  });
});

describe("生产配置自检 · 既有规则的回归锚", () => {
  // 挑「半配」这一类当锚：它们正是"配了但能跑起来"的典型，而且两个方向都要报
  test("QQ 登录只配一半：两个方向都报", () => {
    const onlyId = collectConfigProblems(prodBase({ QQ_APP_ID: "1905467096" })).problems;
    const onlyKey = collectConfigProblems(prodBase({ QQ_APP_KEY: "k" })).problems;
    expect(onlyId.some((p) => p.includes("缺 QQ_APP_KEY"))).toBe(true);
    expect(onlyKey.some((p) => p.includes("缺 QQ_APP_ID"))).toBe(true);
  });

  test("两个都配齐：不报", () => {
    const both = collectConfigProblems(prodBase({ QQ_APP_ID: "1905467096", QQ_APP_KEY: "k" })).problems;
    expect(both.some((p) => p.includes("QQ 登录"))).toBe(false);
  });

  test("JWT_SECRET 过短 / 仍是示例值：分别报", () => {
    expect(collectConfigProblems(prodBase({ JWT_SECRET: "short" })).problems.some((p) => p.includes("过短"))).toBe(true);
    expect(
      collectConfigProblems(prodBase({ JWT_SECRET: "replace_me_with_a_real_secret_value_x" })).problems.some((p) =>
        p.includes("示例值"),
      ),
    ).toBe(true);
  });

  test("一份合规的生产配置：isProd 为真且这几类问题都不报", () => {
    const { problems, isProd } = collectConfigProblems(prodBase());
    expect(isProd).toBe(true);
    for (const key of ["RUNWAY", "JWT_SECRET", "OTP_PEPPER", "SMS_PROVIDER", "CORS_ORIGINS"]) {
      expect(problems.some((p) => p.includes(key))).toBe(false);
    }
  });
});
