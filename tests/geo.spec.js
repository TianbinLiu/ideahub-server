// tests/geo.spec.js
// 覆盖：utils/geo —— 请求方国家与出片地区的唯一判定（countryOf / videoZoneOf），
// 以及收口后两个老调用方（auth.controller 的登录能力探测、chatSafety.countryOf）各自的回包形状不变。
//
// ★ geoip 大多用 spyOn 控结果：真库随 npm 包更新，拿真实 IP 断言国家会在某次升级后无故变红。
//   只留一组「真库」用例钉住接线（库装好了、真能查到），选的是多年不变的两个公共 DNS。
// ★ 出片按地区拦 Seedance 用的就是这个判定，所以「自报国家的头不认」「Tor 不按出口节点算」这几条
//   每条都有反例钉着 —— 它们漏了不会有任何症状，只会让人绕过去。

const geoip = require("geoip-lite");
const geo = require("../src/utils/geo");
// 两个老调用方放在文件顶上 require：它们会连带加载 mongoose 模型，第一次要几秒，别算进某一条用例里
const safety = require("../src/services/chatSafety.service");
const { getAuthCapabilities } = require("../src/controllers/auth.controller");

afterEach(() => {
  jest.restoreAllMocks();
});

/** 假请求：只有 headers 与 ip 两样，与 clientIp 读的一致 */
const mkReq = (headers = {}, ip) => ({ headers, ip });
/** 让 geoip 回指定国家（null = 查不到），并返回 spy 以便看它被拿什么 IP 查 */
const geoipSays = (country) =>
  jest.spyOn(geoip, "lookup").mockImplementation(() => (country === null ? null : { country }));

describe("countryOf：cf-ipcountry 优先", () => {
  test("有合形状的 cf 头 → 直接用它，source=cf，不去查 geoip", () => {
    const spy = geoipSays("US");
    expect(geo.countryOf(mkReq({ "cf-ipcountry": "CN", "x-real-ip": "8.8.8.8" }))).toEqual({ country: "CN", source: "cf" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("大小写、首尾空白归一", () => {
    geoipSays(null);
    expect(geo.countryOf(mkReq({ "cf-ipcountry": " cn " }))).toEqual({ country: "CN", source: "cf" });
    expect(geo.countryOf(mkReq({ "cf-ipcountry": "us" }))).toEqual({ country: "US", source: "cf" });
  });

  test("cf 头是 XX（Cloudflare 也不知道）→ 回落 geoip，按 clientIp 查", () => {
    const spy = geoipSays("JP");
    expect(geo.countryOf(mkReq({ "cf-ipcountry": "XX", "x-real-ip": "203.0.113.9" }))).toEqual({ country: "JP", source: "geoip" });
    expect(spy).toHaveBeenCalledWith("203.0.113.9");
  });

  test("cf 头是 T1（Tor）→ 国家为空、不拿出口节点去查 geoip（哪怕出口节点查得到 CN）", () => {
    const spy = geoipSays("CN");
    const out = geo.countryOf(mkReq({ "cf-ipcountry": "t1", "x-real-ip": "114.114.114.114" }));
    expect(out).toEqual({ country: "", source: "cf" });
    expect(spy).not.toHaveBeenCalled();
    expect(geo.videoZoneOf(out.country)).toBe("intl");
  });

  test.each([
    ["重复头被拼成的串", "CN, US"],
    ["三位码", "CHN"],
    ["整个国名", "CHINA"],
    ["一位", "C"],
    ["空串", ""],
    ["数字", "86"],
  ])("cf 头形状不对（%s）→ 当没有，回落 geoip", (_label, value) => {
    const spy = geoipSays("DE");
    expect(geo.countryOf(mkReq({ "cf-ipcountry": value, "x-real-ip": "198.51.100.1" }))).toEqual({ country: "DE", source: "geoip" });
    expect(spy).toHaveBeenCalledWith("198.51.100.1");
  });

  test("cf 头不是字符串（手造的数组）→ 当没有", () => {
    geoipSays(null);
    expect(geo.countryOf(mkReq({ "cf-ipcountry": ["CN"] }))).toEqual({ country: "", source: "" });
  });
});

describe("countryOf：geoip 兜底", () => {
  test("IP 只经 rateLimit.clientIp 取：X-Real-IP 优先于 CF-Connecting-IP 与 req.ip", () => {
    const spy = geoipSays("FR");
    const out = geo.countryOf(mkReq({ "x-real-ip": "198.51.100.7", "cf-connecting-ip": "192.0.2.1" }, "10.0.0.1"));
    expect(out).toEqual({ country: "FR", source: "geoip" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("198.51.100.7");
  });

  test("没有 X-Real-IP 时退到 CF-Connecting-IP，再退到 req.ip（IPv4-mapped 前缀剥掉）", () => {
    const spy = geoipSays("FR");
    geo.countryOf(mkReq({ "cf-connecting-ip": "192.0.2.1" }, "10.0.0.1"));
    expect(spy).toHaveBeenLastCalledWith("192.0.2.1");
    geo.countryOf(mkReq({}, "::ffff:192.0.2.55"));
    expect(spy).toHaveBeenLastCalledWith("192.0.2.55");
  });

  test.each([
    ["查不到", null, ""],
    ["回了 XX", "XX", ""],
    ["回了空串", "", ""],
    ["回了小写 us", "us", "US"],
  ])("geoip %s → 归一成空或两位大写", (_label, said, want) => {
    geoipSays(said);
    const out = geo.countryOf(mkReq({ "x-real-ip": "198.51.100.8" }));
    expect(out.country).toBe(want);
    expect(out.source).toBe(want ? "geoip" : "");
  });

  test("geoip 抛错 → 不拖垮请求（回空），但要在日志里响一声", () => {
    jest.spyOn(geoip, "lookup").mockImplementation(() => {
      throw new Error("db\ncorrupt");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(geo.countryOf(mkReq({ "x-real-ip": "198.51.100.9" }))).toEqual({ country: "", source: "" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[geo] geoip lookup failed:");
    // 错误原话过 logSafe：换行不能进日志（伪造整行日志）
    expect(warn.mock.calls[0][1]).not.toMatch(/\n/);
  });

  test("自报国家的头一律不认（x-country-code / x-vercel-ip-country / x-appengine-country）", () => {
    const spy = geoipSays("US");
    const spoof = { "x-country-code": "CN", "x-vercel-ip-country": "CN", "x-appengine-country": "CN", "x-real-ip": "198.51.100.10" };
    expect(geo.countryOf(mkReq(spoof))).toEqual({ country: "US", source: "geoip" });
    expect(spy).toHaveBeenCalledWith("198.51.100.10");
    spy.mockImplementation(() => null);
    expect(geo.countryOf(mkReq(spoof)).country).toBe("");
  });

  test("请求没有 headers、甚至整个 req 缺失都不抛", () => {
    geoipSays(null);
    expect(() => geo.countryOf({})).not.toThrow();
    expect(() => geo.countryOf(undefined)).not.toThrow();
    expect(geo.countryOf(undefined)).toEqual({ country: "", source: "" });
    expect(geo.countryOf({ ip: "127.0.0.1" })).toEqual({ country: "", source: "" });
  });
});

describe("countryOf：真库（只钉接线，不钉具体网段）", () => {
  test.each([
    ["114.114.114.114", "CN"],
    ["8.8.8.8", "US"],
  ])("X-Real-IP %s → %s（source=geoip）", (ip, want) => {
    expect(geo.countryOf(mkReq({ "x-real-ip": ip }))).toEqual({ country: want, source: "geoip" });
  });

  test.each(["127.0.0.1", "10.1.2.3", "203.0.113.7", "anon"])("本机 / 私网 / 文档网段 / 非 IP（%s）→ 空", (ip) => {
    expect(geo.countryOf(mkReq({ "x-real-ip": ip }))).toEqual({ country: "", source: "" });
  });
});

describe("videoZoneOf", () => {
  test("只有 CN 是境内（大小写、空白归一）", () => {
    expect(geo.videoZoneOf("CN")).toBe("cn");
    expect(geo.videoZoneOf("cn")).toBe("cn");
    expect(geo.videoZoneOf(" CN ")).toBe("cn");
  });

  test.each(["HK", "MO", "TW"])("港澳台（%s）判境外 —— 等主人拍板前的默认", (c) => {
    expect(geo.videoZoneOf(c)).toBe("intl");
  });

  test.each(["US", "JP", "GB", "SG", "RU", "UA", "AU"])("其它国家（%s）判境外", (c) => {
    expect(geo.videoZoneOf(c)).toBe("intl");
  });

  test.each([[""], [undefined], [null], ["XX"], ["T1"], ["CHN"], [86]])("不知道是哪国（%p）判境外，不判境内", (c) => {
    expect(geo.videoZoneOf(c)).toBe("intl");
  });

  test.each(["IR", "CU", "KP", "SY", "ir", " kp "])("受全面制裁（%p）→ blocked", (c) => {
    expect(geo.videoZoneOf(c)).toBe("blocked");
  });

  test("与 countryOf 串起来：cf 头 CN / IR / T1 / 没有", () => {
    geoipSays(null);
    const zone = (headers) => geo.videoZoneOf(geo.countryOf(mkReq(headers)).country);
    expect(zone({ "cf-ipcountry": "CN" })).toBe("cn");
    expect(zone({ "cf-ipcountry": "IR" })).toBe("blocked");
    expect(zone({ "cf-ipcountry": "T1" })).toBe("intl");
    expect(zone({})).toBe("intl");
    // 自报 CN 的头不能把人判进境内
    expect(zone({ "x-country-code": "CN" })).toBe("intl");
  });

  test("名单钉死：境内只有 CN、制裁只有这四个，且调用方改不动", () => {
    expect(geo.CN_ZONE_COUNTRIES).toEqual(["CN"]);
    expect([...geo.BLOCKED_COUNTRIES].sort()).toEqual(["CU", "IR", "KP", "SY"]);
    expect(Object.isFrozen(geo.CN_ZONE_COUNTRIES)).toBe(true);
    expect(Object.isFrozen(geo.BLOCKED_COUNTRIES)).toBe(true);
  });
});

describe("收口后的老调用方：回包形状不变", () => {
  test("chatSafety.countryOf 仍回一个国家码字符串；没有 cf 头时用 geoip 兜底", () => {
    geoipSays("CN");
    expect(safety.countryOf(mkReq({ "cf-ipcountry": "us" }))).toBe("US");
    expect(safety.countryOf(mkReq({ "cf-ipcountry": "XX", "x-real-ip": "198.51.100.11" }))).toBe("CN");
    jest.restoreAllMocks();
    geoipSays(null);
    const c = safety.countryOf(mkReq({}));
    expect(c).toBe("");
    expect(safety.crisisResources({ country: c }).region).toBe("OTHER");
  });

  test("登录能力探测的 region / country 照旧：CN / GLOBAL / UNKNOWN 三种", () => {
    const probe = (headers) => {
      let body;
      getAuthCapabilities(mkReq(headers), { json: (b) => { body = b; } });
      return { region: body.region, country: body.country, ok: body.ok };
    };
    const spy = geoipSays("US");
    expect(probe({ "cf-ipcountry": "CN" })).toEqual({ region: "CN", country: "CN", ok: true });
    expect(probe({ "cf-ipcountry": "DE" })).toEqual({ region: "GLOBAL", country: "DE", ok: true });
    // 自报 CN 不再算：按 clientIp 查到的国家
    expect(probe({ "x-country-code": "CN", "x-real-ip": "198.51.100.12" })).toEqual({ region: "GLOBAL", country: "US", ok: true });
    // Tor：不按出口节点算
    expect(probe({ "cf-ipcountry": "T1", "x-real-ip": "198.51.100.13" })).toEqual({ region: "UNKNOWN", country: "", ok: true });
    spy.mockImplementation(() => null);
    expect(probe({})).toEqual({ region: "UNKNOWN", country: "", ok: true });
  });
});
