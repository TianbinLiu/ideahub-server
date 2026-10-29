// tests/videoZone.spec.js
// 覆盖：config/videoRegion（每个地区准用哪几个上游、门禁开着时给得出哪几家、此刻对 App 报哪几家（跟着 gate）、门禁档位、
// 按地区该不该拦（Seedance + MiniMax 连站）、被拦时那句话、开发用的 VIDEO_ZONE_FORCE、启动自检）
// 与 GET /api/video/zone（回包形状、no-store、免登录、限流）+ /api/ark/health 的 videoZone 能力位。
//
// ★ 不出网、不花钱：这些判定都在发请求之前；端点只读 env 与请求头。geoip 用 spyOn 控结果（真库的接线在 tests/geo.spec.js 钉着）。
// ★ 这一组判据漏了都**零症状**：providers 不看配置 = App 摆一个点下去必 501 的档；拒绝话里带双引号 = 老 App 只显示半句；
//   生产认了 VIDEO_ZONE_FORCE = 整道地区门禁失效。所以每一条都有反例。
const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const geoip = require("geoip-lite");

const region = require("../src/config/videoRegion");
const { VIDEO_MULT, SEEDANCE_2_5, IMAGE_MODELS, videoPlanDenial, isVideoGeneration, MINIMAX_H3_LITE, MINIMAX_H3, MINIMAX_SEC_COST } = require("../src/config/tokens");
const { collectConfigProblems } = require("../src/config/preflight");

/**
 * 一份「这台服务器的 V2（H3）没开」的 videoRegion（config/minimax.minimaxV2Enabled 换成恒假，别的照真的）。
 * ★ 为什么要造：V2 开不开今天只看站（国际站才开），而海外能换到 MiniMax 的前提就是国际站 —— 真实配置下
 *   「海外给得出 MiniMax、V2 却没开」造不出来，「MiniMax 要付费」那一句（swapVariant 的 paidOnly）就只剩这一种测法。
 *   它是兜底：V2 哪天多一个开关、或免费档里撤掉 H3-Lite，海外的免费用户听到的就该是这一句。
 */
function regionWithoutV2() {
  let mod;
  jest.isolateModules(() => {
    jest.doMock("../src/config/minimax", () => ({ ...jest.requireActual("../src/config/minimax"), minimaxV2Enabled: () => false }));
    mod = require("../src/config/videoRegion");
  });
  jest.dontMock("../src/config/minimax");
  return mod;
}

/** 这些 env 每条用例都从干净的开始（判据全是现读 env，脏值会让用例互相污染、也会让结论取决于跑测试的机器）。
 *  FREE_VIDEO_GATE：拒绝话「指不指人去换 MiniMax」要问真人档对免费用户开不开（tokens.videoPlanDenial 现读它） */
const ENV_KEYS = ["ARK_API_KEY", "MINIMAX_API_KEY", "MINIMAX_INTL_API_KEY", "MINIMAX_REGION", "VIDEO_REGION_GATE", "VIDEO_ZONE_FORCE", "FREE_VIDEO_GATE"];

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** 两家都配了 key（假 key：这些用例一个字节都不出网）。MiniMax 只配国际站 = config/minimax 判成 intl */
const BOTH = { ARK_API_KEY: "ark-test", MINIMAX_INTL_API_KEY: "mm-test" };
/** 两家都配了，但 MiniMax 走中国站 */
const BOTH_CN_SITE = { ARK_API_KEY: "ark-test", MINIMAX_API_KEY: "mm-cn-test" };
/** 门禁开着（政策真生效的那一档） */
const ON = { VIDEO_REGION_GATE: "on" };
/** 真人档模型（tokens.MINIMAX_FLAT_COST 在册的那一个） */
const MM_MODEL = "MiniMax-Hailuo-2.3-Fast";

/** 让 geoip 回指定国家（null = 查不到） */
const geoipSays = (country) => jest.spyOn(geoip, "lookup").mockImplementation(() => (country === null ? null : { country }));

/** 老 App 抠拒绝话的那条正则（app 仓 ai/arkClient.billingDenialError），原样抄来：它对着的是**原始回包文本** */
const OLD_APP_MESSAGE_RE = /"message"\s*:\s*"([^"]+)"/;

let warnSpy;
let errorSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("ZONE_UPSTREAMS：每个地区按政策准用哪几个上游（MiniMax 连站一起算）", () => {
  test("cn 方舟 + MiniMax 两个站、intl 只准 MiniMax 国际站、blocked 一个都不准；常量冻结、调用方改不动", () => {
    expect(region.ZONE_UPSTREAMS).toEqual({ cn: ["ark", "minimax:cn", "minimax:intl"], intl: ["minimax:intl"], blocked: [] });
    expect(Object.isFrozen(region.ZONE_UPSTREAMS)).toBe(true);
    for (const list of Object.values(region.ZONE_UPSTREAMS)) expect(Object.isFrozen(list)).toBe(true);
  });

  test("zoneProviders = 政策的对外名字（站不往外报、去重）；返回新数组、改不动常量", () => {
    expect(region.zoneProviders("cn")).toEqual(["ark", "minimax"]);
    expect(region.zoneProviders("intl")).toEqual(["minimax"]);
    expect(region.zoneProviders("blocked")).toEqual([]);
    const copy = region.zoneProviders("cn");
    copy.push("runway");
    expect(region.zoneProviders("cn")).toEqual(["ark", "minimax"]);
  });

  test("utils/geo.videoZoneOf 回得出的每个地区，这张表里都有（漏一个 = 那个地区的人一来就抛）", () => {
    const { videoZoneOf } = require("../src/utils/geo");
    for (const c of ["CN", "US", "HK", "IR", "", "XX"]) {
      expect(Object.keys(region.ZONE_UPSTREAMS)).toContain(videoZoneOf(c));
    }
  });
});

describe("allowedProviders：门禁开着时 = 政策 ∩ 这台服务器接着的上游", () => {
  test.each([
    ["一把 key 都没配", {}, { cn: [], intl: [], blocked: [] }],
    ["只配方舟", { ARK_API_KEY: "a" }, { cn: ["ark"], intl: [], blocked: [] }],
    ["只配 MiniMax 国际站", { MINIMAX_INTL_API_KEY: "m" }, { cn: ["minimax"], intl: ["minimax"], blocked: [] }],
    // ★ 2026-10-26 审核：海外只准国际站。原来这一行钉的是 intl: [minimax]（配没配不分站）—— 与主人原话正相反
    ["★ 只配 MiniMax 中国站：境内照给，海外不给", { MINIMAX_API_KEY: "m" }, { cn: ["minimax"], intl: [], blocked: [] }],
    ["★ 两把 MiniMax key 都配、MINIMAX_REGION=cn：走中国站，海外不给", { MINIMAX_API_KEY: "m", MINIMAX_INTL_API_KEY: "i", MINIMAX_REGION: "cn" }, { cn: ["minimax"], intl: [], blocked: [] }],
    ["两把 MiniMax key 都配、MINIMAX_REGION=intl：走国际站，海外给", { MINIMAX_API_KEY: "m", MINIMAX_INTL_API_KEY: "i", MINIMAX_REGION: "intl" }, { cn: ["minimax"], intl: ["minimax"], blocked: [] }],
    ["两家都配（MiniMax 国际站）", BOTH, { cn: ["ark", "minimax"], intl: ["minimax"], blocked: [] }],
    ["两家都配（MiniMax 中国站）", BOTH_CN_SITE, { cn: ["ark", "minimax"], intl: [], blocked: [] }],
  ])("%s", async (_label, env, want) => {
    await withEnv(env, () => {
      for (const zone of Object.keys(want)) {
        expect(region.allowedProviders(zone)).toEqual(want[zone]);
        expect(region.offeredProviders(zone, "on")).toEqual(want[zone]);
      }
    });
  });

  test("每次现读：同一个进程里配上 / 拿掉 key 立刻跟着变", async () => {
    await withEnv({}, () => {
      expect(region.allowedProviders("intl")).toEqual([]);
      process.env.MINIMAX_INTL_API_KEY = "m";
      expect(region.allowedProviders("intl")).toEqual(["minimax"]);
    });
  });
});

describe("offeredProviders：此刻对 App 报哪几家 —— 跟着 gate 走（App 只照它摆档）", () => {
  test.each(["off", "observe"])("gate=%s：服务端一发都不拦 → 报配了的全部几家、不看地区（blocked 也一样）", async (gate) => {
    for (const [env, want] of [[BOTH, ["ark", "minimax"]], [BOTH_CN_SITE, ["ark", "minimax"]], [{ ARK_API_KEY: "a" }, ["ark"]], [{}, []]]) {
      await withEnv(env, () => {
        for (const zone of ["cn", "intl", "blocked"]) expect(region.offeredProviders(zone, gate)).toEqual(want);
      });
    }
  });

  test("gate=on：= allowedProviders（境外只剩 MiniMax 国际站，blocked 空）", async () => {
    await withEnv(BOTH, () => {
      expect(region.offeredProviders("cn", "on")).toEqual(["ark", "minimax"]);
      expect(region.offeredProviders("intl", "on")).toEqual(["minimax"]);
      expect(region.offeredProviders("blocked", "on")).toEqual([]);
    });
  });

  test("不传 gate 时现读 VIDEO_REGION_GATE（缺省 observe = 全报）", async () => {
    await withEnv(BOTH, () => {
      expect(region.offeredProviders("intl")).toEqual(["ark", "minimax"]);
      process.env.VIDEO_REGION_GATE = "on";
      expect(region.offeredProviders("intl")).toEqual(["minimax"]);
      process.env.VIDEO_REGION_GATE = "off";
      expect(region.offeredProviders("blocked")).toEqual(["ark", "minimax"]);
    });
  });

  test("没配 key 的那家在哪一档都不报（不让 App 摆一个点下去必 501 的档）", async () => {
    await withEnv({ MINIMAX_INTL_API_KEY: "m" }, () => {
      for (const gate of ["off", "observe", "on"]) expect(region.offeredProviders("cn", gate)).not.toContain("ark");
    });
  });

  test("zone 认不出照样抛（哪一档都是）", () => {
    for (const gate of ["off", "observe", "on"]) expect(() => region.offeredProviders("us", gate)).toThrow(TypeError);
  });
});

describe("gateMode：VIDEO_REGION_GATE", () => {
  test.each([
    [undefined, "observe"],
    ["", "observe"],
    ["off", "off"],
    ["observe", "observe"],
    ["on", "on"],
    [" ON ", "on"],
    ["Off", "off"],
    // 认不出的一律 observe（不当 on，也不当 off）—— 启动自检另外报出来（见下）
    ["enable", "observe"],
    ["true", "observe"],
    ["1", "observe"],
    ["onn", "observe"],
  ])("%p → %s", (value, want) => {
    expect(region.gateMode(value === undefined ? {} : { VIDEO_REGION_GATE: value })).toBe(want);
  });

  test("缺省读 process.env，每次现读", async () => {
    await withEnv({}, () => {
      expect(region.gateMode()).toBe("observe");
      process.env.VIDEO_REGION_GATE = "on";
      expect(region.gateMode()).toBe("on");
    });
  });
});

describe("regionDenial：只拦出视频（Seedance 按地区、MiniMax 按地区 + 站）", () => {
  const SEEDANCE = Object.keys(VIDEO_MULT);

  test("表里确实有 Seedance 几档（2.5 / 2.0 mini / 1.0 两档），别让下面的循环空转", () => {
    expect(SEEDANCE).toContain(SEEDANCE_2_5);
    expect(SEEDANCE.length).toBeGreaterThanOrEqual(4);
  });

  test.each(SEEDANCE)("境外 × %s → 拦（code / reason / zone / providers / message）", async (model) => {
    await withEnv(BOTH, () => {
      const d = region.regionDenial({ kind: "task", model, zone: "intl" });
      expect(d).toEqual({
        code: "REGION_UNAVAILABLE",
        reason: "region",
        zone: "intl",
        providers: ["minimax"],
        message: expect.stringContaining("MiniMax"),
      });
    });
  });

  test.each(SEEDANCE)("境内 × %s → 放行", async (model) => {
    await withEnv(BOTH, () => {
      expect(region.regionDenial({ kind: "task", model, zone: "cn" })).toBeNull();
    });
  });

  test("受全面制裁的地区 × Seedance → 拦，providers 为空（哪怕 MiniMax 配了），话里不指人去换 MiniMax", async () => {
    await withEnv(BOTH, () => {
      const d = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "blocked" });
      expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", reason: "region", zone: "blocked", providers: [] });
      expect(d.message).not.toMatch(/MiniMax/);
      expect(d.message).toMatch(/没有可用的出片模型/);
    });
  });

  test("境外但这台服务器没配 MiniMax → 照样拦、providers 为空、不指一条走不通的路", async () => {
    await withEnv({ ARK_API_KEY: "a" }, () => {
      const d = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" });
      expect(d).toMatchObject({ providers: [] });
      expect(d.message).not.toMatch(/MiniMax/);
    });
  });

  test("准不准用不看配置：境内没配方舟 key 也不拦（那一发自己会 501），境外没配方舟也照拦", async () => {
    await withEnv({}, () => {
      expect(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "cn" })).toBeNull();
      expect(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" })).not.toBeNull();
    });
  });

  test.each([
    ["出图（Seedream）", "image", [...IMAGE_MODELS][0]],
    ["对话 / 推演 / 客服（豆包）", "chat", "doubao-seed-2-1-turbo-260628"],
    ["Seed3D（kind 也是 task，但不是 Seedance）", "task", "doubao-seed3d-2-0-260328"],
    ["不在册的模型（在册检查另有一道，不归这里）", "task", "doubao-seedance-9-9-999999"],
    ["Runway（等主人定）", "runway", "gen4_turbo"],
    ["Seedance 的模型 id 却不是任务（kind 不对）", "image", SEEDANCE_2_5],
  ])("境外 / 受制裁 × %s → 不归这道闸管（2026-10-26 只拦出视频的 Seedance 与 MiniMax，范围等主人定）", async (_label, kind, model) => {
    await withEnv(BOTH, () => {
      expect(region.gatedProviderOf(kind, model)).toBeNull();
      expect(region.regionDenial({ kind, model, zone: "intl" })).toBeNull();
      expect(region.regionDenial({ kind, model, zone: "blocked" })).toBeNull();
    });
  });

  test("★ 不归这道闸管的调用：zone 漏传 / 认不出都不抛、照常放行（chargedArkCall 上的出图 / 对话 / 服务端自己发起的调用手上可能没有 req）", async () => {
    await withEnv(BOTH, () => {
      for (const zone of [undefined, null, "", "CN", {}]) {
        expect(region.regionDenial({ kind: "chat", model: "doubao-seed-2-1-turbo-260628", zone })).toBeNull();
        expect(region.regionDenial({ kind: "image", model: [...IMAGE_MODELS][0], zone })).toBeNull();
        expect(region.regionDenial({ kind: "task", model: "doubao-seed3d-2-0-260328", zone })).toBeNull();
      }
    });
    // 没配 MiniMax：真人档那一发在 minimax.routes 扣费之前就 501 了，不归这道闸管 —— zone 漏传也不抛
    await withEnv({ ARK_API_KEY: "a" }, () => {
      expect(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: undefined })).toBeNull();
      expect(region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3_LITE, zone: undefined })).toBeNull();
    });
  });

  test("gatedProviderOf：Seedance → ark；真人档 → 这台服务器走的那个 MiniMax 站；没配 MiniMax → 不归这道闸管", async () => {
    await withEnv(BOTH, () => {
      expect(region.gatedProviderOf("task", SEEDANCE_2_5)).toBe("ark");
      expect(region.gatedProviderOf("minimax_video", MM_MODEL)).toBe("minimax:intl");
    });
    await withEnv(BOTH_CN_SITE, () => {
      expect(region.gatedProviderOf("minimax_video", MM_MODEL)).toBe("minimax:cn");
    });
    await withEnv({ ARK_API_KEY: "a" }, () => {
      expect(region.gatedProviderOf("minimax_video", MM_MODEL)).toBeNull();
    });
  });

  // 2026-10-26 审核：minimax_v2（H3 的 V2 出片）一度只进了 tokens.isVideoGeneration、没进 gatedProviderOf ——
  // regionGate 见 null 就整个跳过：不拦、不记 would-deny、没带 req 也不抛，受全面制裁的地区照样出 H3。零症状。
  test("gatedProviderOf：H3（minimax_v2）与真人档同一个判法 —— 按这台服务器走的站；没配 MiniMax → 不归这道闸管", async () => {
    for (const model of [MINIMAX_H3_LITE, MINIMAX_H3, "whatever"]) {
      await withEnv(BOTH, () => expect(region.gatedProviderOf("minimax_v2", model)).toBe("minimax:intl"));
      await withEnv(BOTH_CN_SITE, () => expect(region.gatedProviderOf("minimax_v2", model)).toBe("minimax:cn"));
      await withEnv({ ARK_API_KEY: "a" }, () => expect(region.gatedProviderOf("minimax_v2", model)).toBeNull());
    }
  });

  test("H3（minimax_v2）× MiniMax 国际站：境内 / 境外放行，受全面制裁的地区拦（providers 空、话里不指人去换 MiniMax）", async () => {
    await withEnv(BOTH, () => {
      for (const paid of [null, true, false]) {
        expect(region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3_LITE, zone: "cn", paid })).toBeNull();
        expect(region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3_LITE, zone: "intl", paid })).toBeNull();
        const d = region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3_LITE, zone: "blocked", paid });
        expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", reason: "region", zone: "blocked", providers: [] });
        expect(d.message).not.toMatch(/MiniMax/);
        expect(d.message).toMatch(/没有可用的出片模型/);
      }
    });
  });

  test("H3（minimax_v2）× MiniMax 中国站：境外也拦（海外只准国际站；V2 路由在中国站上本来就不开，这里是第二道）", async () => {
    await withEnv(BOTH_CN_SITE, () => {
      expect(region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3, zone: "cn" })).toBeNull();
      const d = region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3, zone: "intl" });
      expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", zone: "intl", providers: [] });
      expect(d.message).not.toMatch(/MiniMax/);
    });
  });

  test("★ tokens.isVideoGeneration 认的每一种出视频的 kind 都归这道闸管（Runway 除外：文件头 ①，范围等主人定）", async () => {
    // 从源码里把 isVideoGeneration 认的 kind 抠出来，而不是在这里抄一份清单：新加一种 kind 时这条会自己把它带进来
    const src = fs.readFileSync(path.join(__dirname, "../src/config/tokens.js"), "utf8");
    const body = /function isVideoGeneration\([^)]*\)\s*\{([\s\S]*?)\r?\n\}/.exec(src)?.[1];
    expect(body).toBeTruthy();
    const kinds = [...new Set([...body.matchAll(/kind === "([a-z0-9_]+)"/g)].map((m) => m[1]))];
    expect(kinds).toEqual(expect.arrayContaining(["task", "minimax_video", "minimax_v2", "runway"]));
    /** 刻意不归这道闸管的出视频 kind（每一条都要有理由） */
    const NOT_GATED = { runway: "Runway 海外没有替代、范围等主人定（videoRegion 文件头 ①）" };
    await withEnv(BOTH, () => {
      for (const kind of kinds) {
        const model = kind === "task" ? SEEDANCE_2_5 : "any-model";
        expect({ kind, video: isVideoGeneration(kind, model) }).toEqual({ kind, video: true });
        expect({ kind, gated: region.gatedProviderOf(kind, model) !== null }).toEqual({ kind, gated: !Object.hasOwn(NOT_GATED, kind) });
      }
    });
  });

  test("真人档 × MiniMax 国际站：境内 / 境外放行，受全面制裁的地区拦（providers 空、话里不指人去换 MiniMax）", async () => {
    await withEnv(BOTH, () => {
      expect(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "cn" })).toBeNull();
      expect(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "intl" })).toBeNull();
      const d = region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "blocked" });
      expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", reason: "region", zone: "blocked", providers: [] });
      expect(d.message).not.toMatch(/MiniMax/);
      expect(d.message).toMatch(/没有可用的出片模型/);
    });
  });

  test("★ 真人档 × MiniMax 中国站：境内放行，境外也拦（海外只准国际站）—— 与 /api/video/zone 不对海外报 minimax 是同一个答案", async () => {
    await withEnv(BOTH_CN_SITE, () => {
      expect(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "cn" })).toBeNull();
      const d = region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "intl" });
      expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", zone: "intl", providers: [] });
      expect(d.message).not.toMatch(/MiniMax/);
      expect(region.offeredProviders("intl", "on")).toEqual(d.providers);
      // Seedance 在海外被拦时也不指人去换一个这台服务器给不了的 MiniMax
      const s2 = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" });
      expect(s2.providers).toEqual([]);
      expect(s2.message).not.toMatch(/MiniMax/);
    });
  });

  test("一致性：每个地区 × 每种配置，门禁开着时「报给 App 的 providers」与「出片那一发拦不拦」说的是同一件事", async () => {
    for (const env of [BOTH, BOTH_CN_SITE, { ARK_API_KEY: "a" }, { MINIMAX_INTL_API_KEY: "m" }, { MINIMAX_API_KEY: "m" }]) {
      await withEnv(env, () => {
        for (const zone of ["cn", "intl", "blocked"]) {
          const offered = region.offeredProviders(zone, "on");
          // 报了 ark ⇒ Seedance 那一发不拦（没配方舟时 ark 不报，但准不准用不看配置 —— 见「准不准用不看配置」那条）
          if (offered.includes("ark")) expect(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone })).toBeNull();
          // 被拦时回包里的 providers 就是这一份
          const sd = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone });
          if (sd) expect(sd.providers).toEqual(offered);
          // 配了 MiniMax 时：报了 minimax ⇔ 真人档那一发不拦
          if (region.gatedProviderOf("minimax_video", MM_MODEL)) {
            expect(offered.includes("minimax")).toBe(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone }) === null);
          }
          // H3（minimax_v2）与真人档同一个答案：报给 App 的 minimax 说的是这一家，不分 v1 / V2 —— 三档（价目表里的每一个型号）都一样，
          // App 才能拿这一个名字（再加 /api/ark/health 的 minimaxV2）摆三档（契约：routes/videoZone.routes 文件头；经路由的核对在 tests/minimaxV2.spec）
          for (const model of Object.keys(MINIMAX_SEC_COST)) {
            if (!region.gatedProviderOf("minimax_v2", model)) continue;
            expect({ env, zone, model, offered: offered.includes("minimax") }).toEqual({
              env,
              zone,
              model,
              offered: region.regionDenial({ kind: "minimax_v2", model, zone }) === null,
            });
          }
        }
      });
    }
  });

  test("纯判定、不看 gate：off / observe / on 下结论一样（怎么执行由门禁那一处按 gateMode 决定）", async () => {
    for (const gate of ["off", "observe", "on"]) {
      await withEnv({ ...BOTH, VIDEO_REGION_GATE: gate }, () => {
        expect(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" })).not.toBeNull();
      });
    }
  });

  test.each([[undefined], [null], [""], ["CN"], ["us"], ["cn "], [{}], [1]])("归这道闸管的调用 zone 漏传 / 认不出（%p）→ 直接抛，不给缺省值", async (zone) => {
    expect(() => region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone })).toThrow(TypeError);
    await withEnv(BOTH, () => {
      expect(() => region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone })).toThrow(TypeError);
      expect(() => region.regionDenial({ kind: "minimax_v2", model: MINIMAX_H3_LITE, zone })).toThrow(TypeError);
    });
  });

  test("连参数都没给 → 不归这道闸管、放行（kind 都没有）；给了 Seedance 却没给 zone → 抛", () => {
    expect(region.regionDenial()).toBeNull();
    expect(() => region.regionDenial({ kind: "task", model: SEEDANCE_2_5 })).toThrow(TypeError);
  });
});

// 2026-10-26 最终审核：原来只要这个地区给得出 MiniMax，每一发被拦的 Seedance 都说「换成 MiniMax」——
// 包括 MiniMax 根本做不了的（白模化 / 模板段 / 重拍 / 延长 / 样片第二步），以及套餐用不了真人档的免费用户（换过去就是 403 PLAN_REQUIRED）。
describe("拒绝话只在 MiniMax 真做得了这一发时才指人去换 MiniMax（swapVariant）", () => {
  const SWAP = /Switch the model to MiniMax/;
  const deny = (o) => region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", ...o });

  test.each([
    ["白模化的预检记号", { r2v: { kind: "blockout" } }],
    ["白模模板段（命中已登记模板）", { r2v: { templateId: "t1", durationSec: 8 } }],
    ["片段重拍（本人成片 edit）", { r2v: { kind: "ownEdit", durationSec: 5 } }],
    ["往后延长（本人成片 extend）", { r2v: { kind: "ownExtend", durationSec: 5, outputSec: 5 } }],
    ["素材参考", { r2v: { kind: "material", durationSec: 6 } }],
    ["样片第二步（升 1080p）", { draftFinal: { draftTaskId: "cgt-1", durationSec: 5 } }],
  ])("%s → 「没有可换的」：不指人去换 MiniMax（付费用户也一样），providers 照实报", async (_label, o) => {
    await withEnv(BOTH, () => {
      for (const paid of [null, true, false]) {
        const d = deny({ ...o, paid });
        expect(d).toMatchObject({ code: "REGION_UNAVAILABLE", reason: "region", zone: "intl", providers: ["minimax"] });
        expect(d.message).not.toMatch(SWAP);
        expect(d.message).not.toMatch(/MiniMax/);
        expect(d.message).toMatch(/this kind of video has no other model here/);
        expect(d.message).toMatch(/没有别的模型可换/);
      }
    });
  });

  test("普通出片、付费用户 / 不知道套餐 → 「换 MiniMax」", async () => {
    await withEnv(BOTH, () => {
      expect(deny({ paid: true }).message).toMatch(SWAP);
      expect(deny({ paid: null }).message).toMatch(SWAP);
      expect(deny({}).message).toMatch(SWAP);
    });
  });

  // 2026-10-26 审核：H3-Lite · 480P 进了免费档之后，这里原来只问真人档 —— 海外的免费用户被告知「MiniMax 要付费」，
  // 而他们明明有一档免费的（话把人往付钱那边推）。现在问的是「这台服务器上的 MiniMax 有没有一档对他开着」（videoRegion.minimaxOpenTo）。
  test("★ 普通出片、免费用户（免费档门禁缺省开）、国际站（V2 开着）→ 「换 MiniMax」：H3-Lite · 480P 对免费版开着，真人档仍只给付费用户", async () => {
    await withEnv(BOTH, () => {
      // 同一个判据（tokens.videoPlanDenial）：真人档对没付过钱的人关着，H3-Lite · 480P 开着
      expect(videoPlanDenial({ paid: false, kind: "minimax_video", model: MM_MODEL })).not.toBeNull();
      expect(videoPlanDenial({ paid: false, kind: "minimax_v2", model: MINIMAX_H3_LITE, resolution: "480P" })).toBeNull();
      expect(require("../src/config/minimax").minimaxV2Enabled()).toBe(true);
      const d = deny({ paid: false });
      expect(d.providers).toEqual(["minimax"]);
      expect(d.message).toMatch(SWAP);
      expect(d.message).not.toMatch(/paid plan|付费套餐/);
      // 这句话只有老 App 原样显示，而老 App 的 MiniMax 只有真人档 —— 免费用户看得见它、却是灰的「会员档」。
      // 所以更新的提示要说「没有**能用的**就更新」，不能只说「没有的话」（看见了就不会去更新，只会以为要付钱；免费的 H3-Lite 在新版里）
      expect(d.message).toMatch(/update the app if none is usable/);
      expect(d.message).toMatch(/没有能用的就先更新 App/);
      // 付费用户 / 不知道套餐听到的是同一句（一句话两种人都说得对，不按套餐另拼）
      expect(deny({ paid: true }).message).toBe(d.message);
      expect(deny({}).message).toBe(d.message);
    });
  });

  test("★ 普通出片、免费用户、这台服务器的 V2 没开 → 「MiniMax 要付费套餐」，不说「换成 MiniMax」（只剩真人档，而它只给付费用户）", async () => {
    const noV2 = regionWithoutV2();
    await withEnv(BOTH, () => {
      const d = noV2.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", paid: false });
      expect(d.providers).toEqual(["minimax"]);
      expect(d.message).not.toMatch(SWAP);
      expect(d.message).toMatch(/MiniMax works here with a paid plan or after any top-up/);
      expect(d.message).toMatch(/MiniMax 要付费套餐，或充值过任意一次/);
      // 付费用户 / 免费档门禁关着（真人档对免费用户也开）照样是「换 MiniMax」
      expect(noV2.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", paid: true }).message).toMatch(SWAP);
    });
    await withEnv({ ...BOTH, FREE_VIDEO_GATE: "off" }, () => {
      expect(noV2.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", paid: false }).message).toMatch(SWAP);
    });
  });

  test("免费档门禁关着（FREE_VIDEO_GATE=off：真人档对免费用户也开）→ 免费用户也是「换 MiniMax」", async () => {
    await withEnv({ ...BOTH, FREE_VIDEO_GATE: "off" }, () => {
      expect(videoPlanDenial({ paid: false, kind: "minimax_video", model: MM_MODEL })).toBeNull();
      expect(deny({ paid: false }).message).toMatch(SWAP);
    });
  });

  test("这几样只挑句子、不改拦不拦：境内照样放行；受全面制裁 / 给不出 MiniMax 的照样是「一家都没有」", async () => {
    await withEnv(BOTH, () => {
      for (const o of [{ r2v: { kind: "blockout" } }, { draftFinal: { draftTaskId: "x" } }, { paid: false }, { paid: true }]) {
        expect(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "cn", ...o })).toBeNull();
        const b = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "blocked", ...o });
        expect(b.providers).toEqual([]);
        expect(b.message).toMatch(/没有可用的出片模型/);
        // 真人档按站拦的那一发：被拦的本来就是 MiniMax，不会指人去换 MiniMax
        expect(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "blocked", ...o }).message).not.toMatch(/MiniMax/);
      }
    });
    await withEnv(BOTH_CN_SITE, () => {
      // 海外给不出 MiniMax（这台服务器走中国站）：付费用户也不指
      expect(deny({ paid: true }).message).not.toMatch(/MiniMax/);
    });
  });
});

describe("withDenialNote：在拒绝话两半后面各补一句（格式只在 videoRegion 一处）", () => {
  const NOTE = { en: "The frame check that ran first was charged.", zh: "不过看画面那一步的费用已经产生。" };

  test("英文补在英文那半、中文补在中文那半，仍是「英文 / 中文」一行；老 App 的正则抠得出整句、JSON 不用转义", async () => {
    await withEnv(BOTH, () => {
      const base = region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", r2v: { kind: "blockout" } }).message;
      const m = region.withDenialNote(base, NOTE);
      const [en, zh] = m.split(" / ");
      expect(m.split(" / ")).toHaveLength(2);
      expect(en).toBe(`${base.split(" / ")[0]} ${NOTE.en}`);
      expect(zh).toBe(`${base.split(" / ")[1]}${NOTE.zh}`);
      expect(m).not.toMatch(/。。/);
      expect(JSON.stringify(m)).toBe(`"${m}"`);
      expect(OLD_APP_MESSAGE_RE.exec(JSON.stringify({ ok: false, message: m }))?.[1]).toBe(m);
    });
  });

  test.each([
    ["不是拒绝话（没有「 / 」）", "随便一句话", NOTE],
    ["不是拒绝话（两处「 / 」）", "a / b / c", NOTE],
    ["补的话带双引号", "a / b", { en: 'say "hi"', zh: "好" }],
    ["补的话带反斜杠", "a / b", { en: "a\\b", zh: "好" }],
    ["补的话带换行", "a / b", { en: "ok", zh: "第一行\n第二行" }],
    ["补的话自己带「 / 」", "a / b", { en: "x / y", zh: "好" }],
    ["少一种语言", "a / b", { en: "ok" }],
  ])("%s → 抛（编程错误要响，别悄悄拼出一句老 App 抠不全的话）", (_label, msg, note) => {
    expect(() => region.withDenialNote(msg, note)).toThrow(TypeError);
  });
});

describe("拒绝话：中英双语一行，老 App 抠得全、截得下", () => {
  const messages = async () => {
    const out = [];
    await withEnv(BOTH, () => out.push(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" }).message));
    await withEnv({}, () => out.push(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl" }).message));
    await withEnv(BOTH, () => out.push(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "blocked" }).message));
    await withEnv(BOTH, () => out.push(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "blocked" }).message));
    await withEnv(BOTH_CN_SITE, () => out.push(region.regionDenial({ kind: "minimax_video", model: MM_MODEL, zone: "intl" }).message));
    // 2026-10-26 最终审核加的两种：「没有可换的」（带参考视频 / 样片第二步）与「MiniMax 要付费套餐」（免费用户）
    await withEnv(BOTH, () => out.push(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", r2v: { kind: "ownExtend" } }).message));
    // 「MiniMax 要付费套餐」只在这台服务器上的 MiniMax 没有一档对免费用户开着时才说（国际站上有免费的 H3-Lite），造法见 regionWithoutV2
    const noV2 = regionWithoutV2();
    await withEnv(BOTH, () => out.push(noV2.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", paid: false }).message));
    // 白模化在看帧之后才被拦的那一种（两半各补一句看帧的钱）：一样要截得下、抠得全
    await withEnv(BOTH, () =>
      out.push(
        region.withDenialNote(region.regionDenial({ kind: "task", model: SEEDANCE_2_5, zone: "intl", r2v: { kind: "blockout" } }).message, {
          en: "The frame check that ran first was charged and cannot be refunded.",
          zh: "不过看画面那一步的费用已经产生、无法退回。",
        }),
      ),
    );
    return out;
  };
  /** 补过看帧那句的那一种不在 200 / 150 的预算里：白模化的 App 整句显示、不截（段卡 240 / 步骤日志 160 只对出片那条路） */
  const budgeted = async () => (await messages()).slice(0, -1);

  test("五种拒绝话都在（下面的检查别空转）", async () => {
    const all = await messages();
    expect(all).toHaveLength(8);
    expect(all.some((m) => /Switch the model to MiniMax/.test(m))).toBe(true);
    expect(all.some((m) => /no other model here/.test(m))).toBe(true);
    expect(all.some((m) => /paid plan/.test(m))).toBe(true);
    expect(all.some((m) => /^Video generation is not available/.test(m))).toBe(true);
    expect(all.some((m) => /frame check/.test(m))).toBe(true);
  });

  test("★ 老 App 截得下：英文在前；整句 ≤ 200 字（段卡截 240，后面还要接一小句钱上的话）；英文那半 ≤ 150 字（步骤日志截 160）", async () => {
    for (const m of await budgeted()) {
      expect(m.length).toBeLessThanOrEqual(200);
      const [en, zh] = m.split(" / ");
      expect(en).toMatch(/^[A-Za-z]/);
      expect(en.length).toBeLessThanOrEqual(150);
      expect(en).not.toMatch(/[一-鿿]/);
      expect(zh).toMatch(/[一-鿿]/);
      // 截到 160（步骤日志）也还说得出「没受理、没扣费」
      expect(m.slice(0, 160)).toMatch(/not accepted, not charged/);
    }
  });

  test("指人去换 MiniMax 的那一句：两半都带「换 MiniMax」与「没有就先更新 App」，截到 160 也还在", async () => {
    const [toMiniMax] = await messages();
    const [en, zh] = toMiniMax.split(" / ");
    expect(en).toMatch(/Switch the model to MiniMax/);
    expect(en).toMatch(/update the app/);
    expect(zh).toMatch(/换成 MiniMax/);
    expect(zh).toMatch(/先更新 App/);
    expect(toMiniMax.slice(0, 160)).toMatch(/update the app/);
  });

  test("每一种都有中文也有英文，都说「这一发没受理、没扣费」", async () => {
    for (const m of await messages()) {
      expect(m).toMatch(/[\u4e00-\u9fff]/);
      expect(m).toMatch(/not available in your region/);
      expect(m).toMatch(/没有受理、也没有扣费/);
      expect(m).toMatch(/not charged/);
    }
  });

  test("不许出现 ASCII 双引号、反斜杠、换行 / 控制字符（JSON 里一个字符都不用转义）", async () => {
    for (const m of await messages()) {
      expect(m).not.toMatch(/["\\]/);
      expect(m).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(JSON.stringify(m)).toBe(`"${m}"`);
    }
  });

  test("拿老 App 那条正则对着整份回包原文抠，抠出来的就是整句话", async () => {
    for (const m of await messages()) {
      const raw = JSON.stringify({ ok: false, code: "REGION_UNAVAILABLE", reason: "region", message: m, zone: "intl", providers: [] });
      expect(OLD_APP_MESSAGE_RE.exec(raw)?.[1]).toBe(m);
    }
  });

  test("不写「法规」：出处还没落进文档（见文件头）", async () => {
    for (const m of await messages()) expect(m).not.toMatch(/法规|法律|政策|law|regulat|policy/i);
  });
});

describe("forcedZone / requestZone：地区只在这一处合起来", () => {
  test("没配 VIDEO_ZONE_FORCE：照 geo 判（cf 头 CN / US / IR、什么都没有）", async () => {
    geoipSays(null);
    await withEnv({}, () => {
      expect(region.requestZone({ headers: { "cf-ipcountry": "CN" } })).toEqual({ zone: "cn", country: "CN", source: "cf", forced: false });
      expect(region.requestZone({ headers: { "cf-ipcountry": "US" } })).toEqual({ zone: "intl", country: "US", source: "cf", forced: false });
      expect(region.requestZone({ headers: { "cf-ipcountry": "IR" } })).toEqual({ zone: "blocked", country: "IR", source: "cf", forced: false });
      expect(region.requestZone({ headers: {} })).toEqual({ zone: "intl", country: "", source: "", forced: false });
      // 没有 headers、整个 req 缺失都不抛（geo 的约定）
      expect(region.requestZone(undefined).zone).toBe("intl");
    });
  });

  test("geoip 兜底走到这里（cf 头没有时按 X-Real-IP 查）", async () => {
    const spy = geoipSays("CN");
    await withEnv({}, () => {
      expect(region.requestZone({ headers: { "x-real-ip": "198.51.100.20" } })).toEqual({ zone: "cn", country: "CN", source: "geoip", forced: false });
    });
    expect(spy).toHaveBeenCalledWith("198.51.100.20");
  });

  test("开发环境配了 VIDEO_ZONE_FORCE：zone 钉死，country / source 照实报，forced 为真", async () => {
    geoipSays(null);
    await withEnv({ VIDEO_ZONE_FORCE: "cn" }, () => {
      expect(region.requestZone({ headers: { "cf-ipcountry": "US" } })).toEqual({ zone: "cn", country: "US", source: "cf", forced: true });
    });
    await withEnv({ VIDEO_ZONE_FORCE: " INTL " }, () => {
      expect(region.requestZone({ headers: { "cf-ipcountry": "CN" } })).toMatchObject({ zone: "intl", country: "CN", forced: true });
    });
    await withEnv({ VIDEO_ZONE_FORCE: "blocked" }, () => {
      expect(region.requestZone({ headers: { "cf-ipcountry": "CN" } })).toMatchObject({ zone: "blocked", forced: true });
    });
  });

  test("认不出的值：按没配处理", async () => {
    geoipSays(null);
    await withEnv({ VIDEO_ZONE_FORCE: "china" }, () => {
      expect(region.requestZone({ headers: { "cf-ipcountry": "US" } })).toMatchObject({ zone: "intl", forced: false });
    });
    expect(region.forcedZone({ VIDEO_ZONE_FORCE: "us" })).toBeNull();
    expect(region.forcedZone({ VIDEO_ZONE_FORCE: "" })).toBeNull();
    expect(region.forcedZone({})).toBeNull();
  });

  test("★ 生产环境一律不认（写 cn = 对海外放开 Seedance）：按真实地区判", async () => {
    expect(region.forcedZone({ NODE_ENV: "production", VIDEO_ZONE_FORCE: "cn" })).toBeNull();
    expect(region.forcedZone({ NODE_ENV: "production", VIDEO_ZONE_FORCE: "intl" })).toBeNull();
    geoipSays(null);
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await withEnv({ VIDEO_ZONE_FORCE: "cn" }, () => {
        expect(region.requestZone({ headers: { "cf-ipcountry": "US" } })).toEqual({ zone: "intl", country: "US", source: "cf", forced: false });
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  test("生效 / 认不出 / 生产不认：各在日志里吼一次（同一个进程只一次，不按请求刷屏）", () => {
    let fresh;
    jest.isolateModules(() => {
      fresh = require("../src/config/videoRegion");
    });
    const dev = { NODE_ENV: "development", VIDEO_ZONE_FORCE: "cn" };
    fresh.forcedZone(dev);
    fresh.forcedZone(dev);
    expect(warnSpy.mock.calls.filter((c) => /VIDEO_ZONE_FORCE=cn/.test(c[0]))).toHaveLength(1);

    fresh.forcedZone({ VIDEO_ZONE_FORCE: "nope\nforged" });
    fresh.forcedZone({ VIDEO_ZONE_FORCE: "nope\nforged" });
    const bad = warnSpy.mock.calls.filter((c) => /认不出/.test(c[0]));
    expect(bad).toHaveLength(1);
    // env 的值过 logSafe：换行进不了日志
    expect(bad[0][0]).not.toMatch(/\n/);

    const prod = { NODE_ENV: "production", VIDEO_ZONE_FORCE: "cn" };
    fresh.forcedZone(prod);
    fresh.forcedZone(prod);
    expect(errorSpy.mock.calls.filter((c) => /生产环境配了 VIDEO_ZONE_FORCE/.test(c[0]))).toHaveLength(1);
  });
});

describe("启动自检（config/preflight 并进来的那几条）", () => {
  /** 一份「生产上完全合规」的底座（与 tests/preflight.spec.js 同形） */
  const prodBase = (extra = {}) => ({
    NODE_ENV: "production",
    JWT_SECRET: "x".repeat(40),
    OTP_PEPPER: "a-real-pepper",
    SMS_PROVIDER: "aliyun",
    CORS_ORIGINS: "https://qimeng.example",
    COMPANION_REQUIRE_CONSENT: "1",
    ...extra,
  });
  const regionProblems = (env) => collectConfigProblems(env).problems.filter((p) => /VIDEO_REGION_GATE|VIDEO_ZONE_FORCE/.test(p));

  test("底座本身没有任何问题（下面每条只多它自己那一条）", () => {
    expect(collectConfigProblems(prodBase()).problems).toEqual([]);
  });

  test.each(["cn", "intl", "blocked", "bogus"])("★ 生产配了 VIDEO_ZONE_FORCE=%s → 报，生产拒绝启动", (v) => {
    const out = collectConfigProblems(prodBase({ VIDEO_ZONE_FORCE: v }));
    expect(out.isProd).toBe(true);
    expect(regionProblems(prodBase({ VIDEO_ZONE_FORCE: v }))).toHaveLength(1);
    expect(out.problems.join("\n")).toMatch(/生产环境配了 VIDEO_ZONE_FORCE/);
  });

  test("开发环境配了合形状的 VIDEO_ZONE_FORCE：不报（它就是给开发用的）；认不出的值：报（只告警）", () => {
    expect(regionProblems({ NODE_ENV: "development", VIDEO_ZONE_FORCE: "cn" })).toHaveLength(0);
    expect(regionProblems({ NODE_ENV: "development", VIDEO_ZONE_FORCE: "INTL" })).toHaveLength(0);
    const bad = regionProblems({ NODE_ENV: "development", VIDEO_ZONE_FORCE: "china" });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/认不出/);
  });

  test.each(["enable", "true", "1", "onn"])("VIDEO_REGION_GATE=%s 认不出 → 报（生产拒绝启动；说清按 observe 跑）", (v) => {
    const p = regionProblems(prodBase({ VIDEO_REGION_GATE: v }));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/observe/);
    expect(regionProblems({ NODE_ENV: "development", VIDEO_REGION_GATE: v })).toHaveLength(1);
  });

  test.each(["", "off", "observe", "on", " ON "])("VIDEO_REGION_GATE=%p → 不报", (v) => {
    expect(regionProblems(prodBase({ VIDEO_REGION_GATE: v }))).toHaveLength(0);
  });

  test("问题文案里的 env 值过 logSafe（一个换行就能在部署日志里伪造一行）", () => {
    const [p] = regionProblems({ NODE_ENV: "development", VIDEO_REGION_GATE: "x\n✅ 配置自检通过" });
    expect(p).not.toMatch(/\n/);
  });
});

describe("GET /api/video/zone（真的 app.js）", () => {
  let app;
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
    app = require("../src/app");
  });
  const zoneOf = (headers = {}) => request(app).get("/api/video/zone").set(headers);

  test("境内：两家都配了 → providers 两家；回包只有这六个键；no-store；不要登录", async () => {
    geoipSays(null);
    await withEnv(BOTH, async () => {
      const res = await zoneOf({ "CF-IPCountry": "CN" }).expect(200);
      expect(res.body).toEqual({ ok: true, v: 1, zone: "cn", country: "CN", providers: ["ark", "minimax"], gate: "observe" });
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });

  test("境外（美国）、门禁 on：只有 MiniMax", async () => {
    geoipSays(null);
    await withEnv({ ...BOTH, ...ON }, async () => {
      const res = await zoneOf({ "CF-IPCountry": "US" }).expect(200);
      expect(res.body).toEqual({ ok: true, v: 1, zone: "intl", country: "US", providers: ["minimax"], gate: "on" });
    });
  });

  test("★ 境外、门禁 on、这台服务器的 MiniMax 走中国站：一家都不报（海外只准 MiniMax 国际站）", async () => {
    geoipSays(null);
    await withEnv({ ...BOTH_CN_SITE, ...ON }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "US" })).body).toMatchObject({ zone: "intl", providers: [], gate: "on" });
      expect((await zoneOf({ "CF-IPCountry": "CN" })).body).toMatchObject({ zone: "cn", providers: ["ark", "minimax"] });
    });
  });

  test("港澳台 / Tor / 判不出：境外", async () => {
    geoipSays(null);
    await withEnv(BOTH, async () => {
      expect((await zoneOf({ "CF-IPCountry": "HK" })).body).toMatchObject({ zone: "intl", country: "HK" });
      expect((await zoneOf({ "CF-IPCountry": "T1" })).body).toMatchObject({ zone: "intl", country: "" });
      expect((await zoneOf()).body).toMatchObject({ zone: "intl", country: "" });
    });
  });

  test("受全面制裁的地区、门禁 on：一家都不给", async () => {
    geoipSays(null);
    await withEnv({ ...BOTH, ...ON }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "KP" })).body).toMatchObject({ zone: "blocked", country: "KP", providers: [] });
    });
  });

  test("cf 头没有时按 X-Real-IP 查 geoip", async () => {
    const spy = geoipSays("CN");
    await withEnv(BOTH, async () => {
      expect((await zoneOf({ "X-Real-IP": "198.51.100.30" })).body).toMatchObject({ zone: "cn", country: "CN" });
    });
    expect(spy).toHaveBeenCalledWith("198.51.100.30");
  });

  test("自报国家的头不认（x-country-code: CN 进不了境内）", async () => {
    geoipSays("US");
    await withEnv(BOTH, async () => {
      expect((await zoneOf({ "x-country-code": "CN", "X-Real-IP": "198.51.100.31" })).body).toMatchObject({ zone: "intl", country: "US" });
    });
  });

  test("providers 与配置取交集：没配 MiniMax 的服务器不对海外说 minimax；一把 key 都没有就是空的", async () => {
    geoipSays(null);
    await withEnv({ ARK_API_KEY: "a", ...ON }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "US" })).body.providers).toEqual([]);
      expect((await zoneOf({ "CF-IPCountry": "CN" })).body.providers).toEqual(["ark"]);
    });
    await withEnv({}, async () => {
      expect((await zoneOf({ "CF-IPCountry": "CN" })).body.providers).toEqual([]);
    });
  });

  test("★ providers 跟着 gate 走：on 才按地区收紧；off / observe / 认不出（按 observe）服务端不拦，就照常全报（急停开关不靠 App 自觉）", async () => {
    geoipSays(null);
    for (const [gate, want, us, kp] of [
      ["on", "on", ["minimax"], []],
      ["off", "off", ["ark", "minimax"], ["ark", "minimax"]],
      ["observe", "observe", ["ark", "minimax"], ["ark", "minimax"]],
      ["enable", "observe", ["ark", "minimax"], ["ark", "minimax"]],
      [undefined, "observe", ["ark", "minimax"], ["ark", "minimax"]],
    ]) {
      await withEnv({ ...BOTH, ...(gate === undefined ? {} : { VIDEO_REGION_GATE: gate }) }, async () => {
        expect((await zoneOf({ "CF-IPCountry": "US" }).expect(200)).body).toMatchObject({ zone: "intl", gate: want, providers: us });
        expect((await zoneOf({ "CF-IPCountry": "KP" }).expect(200)).body).toMatchObject({ zone: "blocked", gate: want, providers: kp });
      });
    }
  });

  test("gate 不是 on 时也只报配了的：没配方舟的服务器不对谁说 ark", async () => {
    geoipSays(null);
    await withEnv({ MINIMAX_INTL_API_KEY: "m", VIDEO_REGION_GATE: "off" }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "CN" })).body.providers).toEqual(["minimax"]);
    });
  });

  test("开发环境 VIDEO_ZONE_FORCE=cn（门禁 on）：zone 钉成 cn，country 照实报；=intl 时美国以外的人也只剩 MiniMax", async () => {
    geoipSays(null);
    await withEnv({ ...BOTH, ...ON, VIDEO_ZONE_FORCE: "cn" }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "US" })).body).toMatchObject({ zone: "cn", country: "US", providers: ["ark", "minimax"] });
    });
    await withEnv({ ...BOTH, ...ON, VIDEO_ZONE_FORCE: "intl" }, async () => {
      expect((await zoneOf({ "CF-IPCountry": "CN" })).body).toMatchObject({ zone: "intl", country: "CN", providers: ["minimax"] });
    });
  });

  test("坏 token 当游客（optionalAuth），照样回", async () => {
    geoipSays(null);
    await withEnv(BOTH, async () => {
      const res = await zoneOf({ "CF-IPCountry": "CN", Authorization: "Bearer not-a-jwt" }).expect(200);
      expect(res.body).toMatchObject({ ok: true, zone: "cn" });
    });
  });

  test("能力位：/api/ark/health 带 videoZone: true，但**不带**地区本身（地区会在会话中途变）", async () => {
    const res = await request(app).get("/api/ark/health").set("CF-IPCountry", "US").expect(200);
    expect(res.body).toMatchObject({ ok: true, videoZone: true });
    expect(res.body).not.toHaveProperty("zone");
    expect(res.body).not.toHaveProperty("providers");
  });
});

// 限流器在 NODE_ENV=test 下整体关闭（middleware/rateLimit 文件头），所以这一组在 NODE_ENV 不是 test 的模块注册表里装路由
// （照 tests/clientEvents.spec.js）：只装这一个路由，限流走没有 Redis 的进程内回退。
// optionalAuth 换成按请求头认人的替身 —— 测的是「登录了按账号分桶、没登录按 IP」，不是 JWT（那一段在 middleware/auth）。
describe("限流：约 60 次/分钟，登录按账号、游客按 IP", () => {
  let mini;

  beforeAll(() => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    let router;
    try {
      jest.isolateModules(() => {
        jest.doMock("../src/middleware/auth", () => ({
          optionalAuth: (req, _res, next) => {
            const u = req.headers["x-test-user"];
            if (u) req.user = { _id: u };
            next();
          },
        }));
        router = require("../src/routes/videoZone.routes");
      });
    } finally {
      process.env.NODE_ENV = saved;
      jest.dontMock("../src/middleware/auth");
    }
    const { errorHandler } = require("../src/middleware/error");
    mini = express();
    mini.use("/api/video", router);
    mini.use(errorHandler);
  });

  test("同一个 IP 的游客第 61 次 → 429（也带 no-store）；另一个 IP 不受影响", async () => {
    geoipSays(null);
    const from = (ip) => request(mini).get("/api/video/zone").set({ "X-Real-IP": ip, "CF-IPCountry": "US" });
    for (let i = 0; i < 60; i++) await from("203.0.113.40").expect(200);
    const res = await from("203.0.113.40").expect(429);
    expect(res.body).toMatchObject({ ok: false, code: "RATE_LIMIT_EXCEEDED" });
    expect(res.headers["cache-control"]).toBe("no-store");
    await from("203.0.113.41").expect(200);
  });

  test("CGNAT：同一个出口 IP 后面两个登录的人各有各的桶（游客那一桶满了也不碍事）", async () => {
    geoipSays(null);
    const ip = "203.0.113.50";
    const as = (user) => request(mini).get("/api/video/zone").set({ "X-Real-IP": ip, "CF-IPCountry": "US", ...(user ? { "x-test-user": user } : {}) });
    for (let i = 0; i < 60; i++) await as(null).expect(200);
    await as(null).expect(429);
    for (let i = 0; i < 60; i++) await as("user-a").expect(200);
    await as("user-a").expect(429);
    await as("user-b").expect(200);
  });
});
