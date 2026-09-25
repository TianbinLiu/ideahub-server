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

describe("生产配置自检 · Runway 接上计费之后，那道硬闸按约定撤掉", () => {
  // ★★ 这条闸原来是「生产配了 RUNWAY_API_KEY 但计费没接 → 拒绝启动」，并在代码里写明
  //   「接上计费之后要连这条一起删 —— 留着它会让『已经接好了』的那天起不来」。
  //   2026-09-24 那一批把 Runway 接进了 billing（chargedCall + 查不到价 501），所以撤掉。
  //   这几条用例留下来，是为了**钉住撤掉这件事本身**：谁再把那句话加回去，这里会红，
  //   而那时生产一配 key 就起不来。
  test("生产配了 RUNWAY_API_KEY：不再报（计费已接）", () => {
    expect(runwayProblems(prodBase({ RUNWAY_API_KEY: "rw_live_xxx" }))).toHaveLength(0);
  });

  test("Runway 的计费链路确实在（路由引到了 billing，且没价就拒）", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "routes", "runway.routes.js"), "utf8");
    expect(src).toMatch(/billing\.chargedCall/);
    expect(src).toMatch(/RUNWAY_NOT_PRICED/);
  });
});

describe("生产配置自检 · SB 243 的同意开关是合并后的手工步骤", () => {
  // ★ 「忘了打开」与「功能没上线」在系统里长得一模一样：服务照常跑、用户照常聊，
  //   只是那道法定告知从来没出现过。所以要么打开、要么显式写 0（让它成为有人做过的决定）。
  const consentProblems = (env) => collectConfigProblems(env).problems.filter((p) => p.includes("CONSENT"));

  test("生产没设这个变量：报出来", () => {
    expect(consentProblems(prodBase())).toHaveLength(1);
  });

  test("显式写 0（决定暂时不开）：不报", () => {
    expect(consentProblems(prodBase({ COMPANION_REQUIRE_CONSENT: "0" }))).toHaveLength(0);
  });

  test("打开了：不报", () => {
    expect(consentProblems(prodBase({ COMPANION_REQUIRE_CONSENT: "1" }))).toHaveLength(0);
  });

  test("非生产不拦（开发不该被这条挡住）", () => {
    expect(consentProblems({ NODE_ENV: "development" })).toHaveLength(0);
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
