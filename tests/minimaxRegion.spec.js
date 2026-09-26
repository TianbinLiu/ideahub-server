// MiniMax 的区域分流：往哪个站打、用哪把 key。
//
// ★★ 为什么这一份值得单独存在：配错站的症状是**「真人档一直失败」**，
//   而失败前钱已经扣过一遍、退过一遍。日志里只有一路 401，没有任何东西会说
//   「你把国际站的 key 配到中国站的地址上了」。判据错了不会有人发现，只会有人重试。
//
// ★ 这里测的是**判据本身**（纯函数，不出网）；转发形状与扣费口径在
//   tests/realPersonProxy.spec.js。两边各管一段，别互相抄。
const path = require("path");

const MOD = path.join("..", "src", "config", "minimax");

/** 每条用例都从干净的 env 开始：判据是"现读 env"，脏值会让用例互相污染 */
function withEnv(vars, fn) {
  const keys = ["MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY", "MINIMAX_REGION"];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn(require(MOD));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("区域判据", () => {
  it("一把 key 都没配：region 为 null、base 为 null、configured 为 false", () => {
    withEnv({}, (m) => {
      expect(m.minimaxRegion()).toBeNull();
      expect(m.minimaxBase()).toBeNull();
      expect(m.minimaxKey()).toBe("");
      expect(m.minimaxConfigured()).toBe(false);
    });
  });

  it("只配中国站：走 api.minimaxi.com，用 MINIMAX_API_KEY", () => {
    withEnv({ MINIMAX_API_KEY: "cn-key" }, (m) => {
      expect(m.minimaxRegion()).toBe("cn");
      expect(m.minimaxBase()).toBe("https://api.minimaxi.com/v1");
      expect(m.minimaxKey()).toBe("cn-key");
    });
  });

  it("只配国际站：走 api.minimax.io，用 MINIMAX_INTL_API_KEY", () => {
    withEnv({ MINIMAX_INTL_API_KEY: "intl-key" }, (m) => {
      expect(m.minimaxRegion()).toBe("intl");
      expect(m.minimaxBase()).toBe("https://api.minimax.io/v1");
      expect(m.minimaxKey()).toBe("intl-key");
    });
  });

  it("★ base 与 key 必须来自**同一个区域**——这正是配错站的那种错法", () => {
    withEnv({ MINIMAX_API_KEY: "cn-key", MINIMAX_INTL_API_KEY: "intl-key", MINIMAX_REGION: "cn" }, (m) => {
      expect(m.minimaxBase()).toBe("https://api.minimaxi.com/v1");
      expect(m.minimaxKey()).toBe("cn-key"); // ← 取成 intl-key 就是「国际站的 key 打中国站」
    });
    withEnv({ MINIMAX_API_KEY: "cn-key", MINIMAX_INTL_API_KEY: "intl-key", MINIMAX_REGION: "intl" }, (m) => {
      expect(m.minimaxBase()).toBe("https://api.minimax.io/v1");
      expect(m.minimaxKey()).toBe("intl-key");
    });
  });

  it("MINIMAX_REGION 指向一把**不存在的 key** 时不认它，回落到有 key 的那边", () => {
    // ★ 否则就是「写了 cn 但 cn 没 key」⇒ 拿空 key 去打中国站，一路 401 而不是 501
    withEnv({ MINIMAX_INTL_API_KEY: "intl-key", MINIMAX_REGION: "cn" }, (m) => {
      expect(m.minimaxRegion()).toBe("intl");
      expect(m.minimaxKey()).toBe("intl-key");
    });
  });

  it("大小写与空白不该让判据失灵（ INTL 也算数）", () => {
    withEnv({ MINIMAX_API_KEY: "cn-key", MINIMAX_INTL_API_KEY: "intl-key", MINIMAX_REGION: "  INTL " }, (m) => {
      expect(m.minimaxRegion()).toBe("intl");
    });
  });

  it("只有空白的 key 等于没配（复制粘贴最容易留下的那种）", () => {
    withEnv({ MINIMAX_API_KEY: "   " }, (m) => {
      expect(m.minimaxConfigured()).toBe(false);
      expect(m.minimaxRegion()).toBeNull();
    });
  });

  it("两把都配又没写区域：给出确定答案（国际站），不留「看读取顺序」的暗门", () => {
    withEnv({ MINIMAX_API_KEY: "cn-key", MINIMAX_INTL_API_KEY: "intl-key" }, (m) => {
      expect(m.minimaxRegion()).toBe("intl");
      expect(m.minimaxRegionAmbiguous()).toBe(true);
    });
  });

  it("写了区域就不算歧义", () => {
    withEnv({ MINIMAX_API_KEY: "cn-key", MINIMAX_INTL_API_KEY: "intl-key", MINIMAX_REGION: "cn" }, (m) => {
      expect(m.minimaxRegionAmbiguous()).toBe(false);
    });
  });
});

describe("生产自检：两把 key 都配了必须说清走哪边", () => {
  const { collectConfigProblems } = require("../src/config/preflight");
  const prodBase = (extra) => ({
    NODE_ENV: "production",
    JWT_SECRET: "x".repeat(40),
    OTP_PEPPER: "a-real-pepper",
    SMS_PROVIDER: "aliyun",
    CORS_ORIGINS: "https://qimeng.example",
    COMPANION_REQUIRE_CONSENT: "0",
    ...extra,
  });
  const mmProblems = (env) => collectConfigProblems(env).problems.filter((p) => p.includes("MINIMAX_REGION"));

  it("两把都配、没写区域：报出来", () => {
    expect(mmProblems(prodBase({ MINIMAX_API_KEY: "a", MINIMAX_INTL_API_KEY: "b" }))).toHaveLength(1);
  });

  it("写了区域：不报", () => {
    expect(mmProblems(prodBase({ MINIMAX_API_KEY: "a", MINIMAX_INTL_API_KEY: "b", MINIMAX_REGION: "intl" }))).toHaveLength(0);
  });

  it("只配一把：不报（这是最常见的正常形态）", () => {
    expect(mmProblems(prodBase({ MINIMAX_INTL_API_KEY: "b" }))).toHaveLength(0);
    expect(mmProblems(prodBase({ MINIMAX_API_KEY: "a" }))).toHaveLength(0);
  });
});
