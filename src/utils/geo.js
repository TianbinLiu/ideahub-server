// src/utils/geo.js
// 请求方在哪个国家、出片该按哪个地区给模型 —— 这两件事的**唯一**判定（铁律六）。
//
// 调用方（2026-10-26）：
//   · auth.controller.detectRegion —— 登录页按地区摆哪套登录方式（UX，不是安全边界）；
//   · chatSafety.countryOf         —— 求助卡给哪个地区的热线；
//   · 出片按地区拦 Seedance（主人原话：美国境内不能用 Seedance、只能用 MiniMax 国际版；
//     中国境内可以选；海外由于政策原因只能用 MiniMax）—— 这一条是**拦人的闸**，所以这里每一步都按
//     「会被人刻意绕」来写，而不是按「猜错了也就是按钮摆错」来写。
//     ⚠ 「政策原因」的出处（条款原文或供应商书面答复）还没落进文档：在那之前它是「按主人要求的产品限制」，
//       注释、文档、知识库里都别写成「法规要求」。
//
// ★ 收口之前有两份：auth.controller 认四个国家头 + 用 req.ip 查 geoip；chatSafety 只认 cf-ipcountry、
//   不兜底。同一个请求在两处能得出两个国家。现在两处都只是从这里取。

const geoip = require("geoip-lite");
const { clientIp } = require("../middleware/rateLimit");
const { logSafe } = require("./logSafe");

/**
 * Cloudflare 的两个「不是国家」的码：XX = 它也不知道；T1 = Tor 出口。
 * ★ 两个都当「没有国家」(country "")，但处理不一样（见 countryOf）：
 *   XX 再去 geoip 查一次；T1 **不再查** —— geoip 查到的只是 Tor 出口节点在哪，与人在哪无关，
 *   拿它判地区就等于让人挑一个出口节点来选地区。
 */
const CF_UNKNOWN = "XX";
const CF_TOR = "T1";

/**
 * 判成「境内」(zone cn，可以选 Seedance) 的国家码。
 * ★ 等主人拍板：港澳台算不算境内。2026-10-26 先按「不算」走 —— 只有 CN。
 *   未知国家（XX / 查不到）与 Tor（T1）一律境外：多给海外的人看一个 Seedance 档，比少给国内的人看一会儿更糟。
 * ★ 写成代码里的常量、不做成环境变量：这是拦人的边界，放宽它应当过一次评审；
 *   环境变量写错一个字母（CN,US）就把整道闸绕开，而且零症状。
 */
const CN_ZONE_COUNTRIES = Object.freeze(["CN"]);

/**
 * 受全面制裁的国家：MiniMax 国际站协议「Export Controls and Sanctions」要求把客户数据交给终端用户时
 * 也守美国 / 新加坡的制裁法规；海外又只给 MiniMax —— 这几处就是没有可用供应商（zone "blocked"：
 * 门禁 on 时 Seedance 与 MiniMax 出视频都拦，规则在 config/videoRegion）。
 * ★ 等主人拍板：名单只按协议里能从国家码认出来的四个写。协议里另列的克里米亚、顿涅茨克、卢甘斯克是
 *   **国家以下**的地区，国家码判不出来（会落在 UA / RU 里），这一层管不到，只能写在文档里。
 */
const BLOCKED_COUNTRIES = Object.freeze(["IR", "CU", "KP", "SY"]);

/**
 * 把一个「据说是国家码」的值规整成两位大写字母；不是这个形状的、以及 XX / T1，一律回 ""。
 * ★ 只认字符串：重复的请求头在 Node 里会被拼成 "CN, US"、数组 / 数字是有人在手造请求 ——
 *   形状不对就当没有，交给下一级来源，不去猜里面哪一段是真的。
 */
function normCountry(value) {
  if (typeof value !== "string") return "";
  const c = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  if (c === CF_UNKNOWN || c === CF_TOR) return "";
  return c;
}

/**
 * 这次请求来自哪个国家。
 *
 * 两级来源，按可信度：
 * 1) `cf-ipcountry`（Cloudflare 按连到它边缘的 IP 填）。
 *    ★ 它可信，**只**因为 2026-08-20 起源站 443 / 80 只对 Cloudflare 网段开放、外面直连不进来；
 *      一旦放开源站直连，任何人都能自己塞一个 `cf-ipcountry: CN`，这一条就不成立了 —— 那时这里必须改。
 *    ⚠ 未核实的两件：Cloudflare 后台的 IP Geolocation 开着（关着它就不加这个头）；客户端自带的同名头
 *      会被 Cloudflare 覆盖而不是透传。上线后看几百个请求的 source 分布再定（设计 P1 那一条）。
 *    ⚠ 门禁切 on 之前还有一道源站加固要做（2026-10-26 最终审核；细节不进公开仓，在运维的私有笔记里，
 *      docs/api-contract.md「出片地区」→「切 on 之前」第 3 步点了名）。都在 nginx / Cloudflare 后台，这里改不了。
 *    ★ 收口之前登录页还认 `x-vercel-ip-country` / `x-country-code` / `x-appengine-country`。
 *      我们不在 Vercel / GAE 上，链路上**没有任何一跳**会去覆盖这三个头 —— 它们全是客户端写的，
 *      认它们 = 谁都能自报国家。出片那道闸用的是同一个判定，所以一并不认了（登录页因此变了什么，见 auth.controller.detectRegion）。
 * 2) geoip-lite 按客户端 IP 查。IP 只经 `rateLimit.clientIp` 取（X-Real-IP 优先，AGENTS.md「真实客户端 IP」），
 *    **不用 req.ip**：取 IP 的顺序只有那一处实现。私网 / 本机 / 库里查不到 → ""。
 *    ⚠ geoip-lite 的库随 npm 包发布，会旧；它只是兜底。
 *
 * @param {object} req Express 请求；没有 headers、甚至 undefined 都不抛
 * @returns {{ country: string, source: "cf" | "geoip" | "" }}
 *   country：两位大写国家码，或 ""（不知道 / Tor）；source：国家码是从哪一级拿到的（Tor 时是 "cf"、country 为空）
 */
function countryOf(req) {
  const raw = req?.headers?.["cf-ipcountry"];
  const cfRaw = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (cfRaw === CF_TOR) return { country: "", source: "cf" };
  const cf = normCountry(cfRaw);
  if (cf) return { country: cf, source: "cf" };

  try {
    // 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 → 1.2.3.4）：clientIp 退到 req.ip 那一级时就是这种写法。
    // geoip-lite 2.0.3 自己认得（实测），剥掉是为了不靠库的这一点行为。
    const ip = String(clientIp(req) || "").trim().replace(/^::ffff:/i, "");
    // ★ 经 geoip.lookup 调（不解构）：测试要能 spyOn 它。
    const hit = ip ? geoip.lookup(ip) : null;
    const country = normCountry(hit?.country);
    if (country) return { country, source: "geoip" };
  } catch (e) {
    // 查不出来不能拖垮请求（登录页、求助卡都在这条路上），但也不能悄悄吞掉 ——
    // geoip-lite 对任意字符串本来只回 null，抛了就是库坏了：那时所有人都落成「境外」，要让人看得见。
    console.warn("[geo] geoip lookup failed:", logSafe(e?.message || e, 200));
  }
  return { country: "", source: "" };
}

/**
 * 国家码 → 出片地区。
 *   "cn"      —— 境内：Seedance 与 MiniMax 都可以选；
 *   "intl"    —— 境外：只给 MiniMax（港澳台、未知、Tor 都在这一档，见 CN_ZONE_COUNTRIES）；
 *   "blocked" —— 受全面制裁：没有可用供应商（见 BLOCKED_COUNTRIES）。
 * 「被拦时对用户说什么」不在这里：那句话跟着拦的那一处走（出片地区门禁）。
 *
 * @param {string} country 一般就是 countryOf(req).country；别的写法也会先过 normCountry
 * @returns {"cn" | "intl" | "blocked"}
 */
function videoZoneOf(country) {
  const c = normCountry(country);
  if (BLOCKED_COUNTRIES.includes(c)) return "blocked";
  if (CN_ZONE_COUNTRIES.includes(c)) return "cn";
  return "intl";
}

/**
 * 境内省级行政区：ISO 3166-2:CN 代码 → 中文名。geoip-lite 的 `region` 与 Cloudflare 的 `cf-region-code`（开了「Add visitor location headers」
 * 那条托管转换才有）给的都是这套代码；`cf-region` 给英文名，所以也按英文名反查一次。
 */
const CN_REGIONS = Object.freeze({
  BJ: "北京", TJ: "天津", HE: "河北", SX: "山西", NM: "内蒙古", LN: "辽宁", JL: "吉林", HL: "黑龙江", SH: "上海", JS: "江苏",
  ZJ: "浙江", AH: "安徽", FJ: "福建", JX: "江西", SD: "山东", HA: "河南", HB: "湖北", HN: "湖南", GD: "广东", GX: "广西",
  HI: "海南", CQ: "重庆", SC: "四川", GZ: "贵州", YN: "云南", XZ: "西藏", SN: "陕西", GS: "甘肃", QH: "青海", NX: "宁夏", XJ: "新疆",
});
const CN_REGION_BY_EN = Object.freeze({
  beijing: "BJ", tianjin: "TJ", hebei: "HE", shanxi: "SX", "inner mongolia": "NM", "nei mongol": "NM", liaoning: "LN", jilin: "JL",
  heilongjiang: "HL", shanghai: "SH", jiangsu: "JS", zhejiang: "ZJ", anhui: "AH", fujian: "FJ", jiangxi: "JX", shandong: "SD",
  henan: "HA", hubei: "HB", hunan: "HN", guangdong: "GD", guangxi: "GX", hainan: "HI", chongqing: "CQ", sichuan: "SC", guizhou: "GZ",
  yunnan: "YN", tibet: "XZ", xizang: "XZ", shaanxi: "SN", gansu: "GS", qinghai: "QH", ningxia: "NX", xinjiang: "XJ",
});

/**
 * IP 属地（2026-10-30）：国家 + 境内到省。国家只问 countryOf（同一把尺）；省：cf-region-code / cf-region 优先，没有再按 clientIp 查 geoip。
 * 港澳台按行业做法（抖音 / 微博）写成地区：country 回 HK / MO / TW、region 为空，展示方按 country 写名字。
 * @returns {{ country: string, region: string }} 都可能为空串（Tor / 查不到）
 */
function regionOf(req) {
  const { country } = countryOf(req);
  if (country !== "CN") return { country, region: "" };
  const h = req?.headers || {};
  const code = typeof h["cf-region-code"] === "string" ? h["cf-region-code"].trim().toUpperCase() : "";
  if (CN_REGIONS[code]) return { country, region: CN_REGIONS[code] };
  const en = typeof h["cf-region"] === "string" ? h["cf-region"].trim().toLowerCase() : "";
  if (en && CN_REGION_BY_EN[en]) return { country, region: CN_REGIONS[CN_REGION_BY_EN[en]] };
  try {
    const ip = String(clientIp(req) || "").trim().replace(/^::ffff:/i, "");
    const hit = ip ? geoip.lookup(ip) : null;
    const r = String(hit?.region || "").toUpperCase();
    if (CN_REGIONS[r]) return { country, region: CN_REGIONS[r] };
  } catch (e) {
    console.warn("[geo] region lookup failed:", logSafe(e?.message || e, 200));
  }
  return { country, region: "" };
}

module.exports = { countryOf, regionOf, videoZoneOf, normCountry, CN_ZONE_COUNTRIES, BLOCKED_COUNTRIES, CN_REGIONS };
