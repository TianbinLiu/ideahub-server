// src/middleware/appVersion.js
// 读 App 带来的版本头 `X-App-Version: <versionName>+<versionCode>`（App 2.63 起每个发往我们 API 的请求都带；
// 例 `2.63+75`，debug 包是 `2.63-debug+75`），解析成 `req.appVersion = { name, code, raw }`；没带 / 写法不对 = null。
//
// ★★ 只用来**记日志**（例：哪些版本还在发方舟下线了的出图 id —— 决定接班表与 LEGACY 价目什么时候能删，
//   见 services/arkGateway.noteImageAlias）。**不许拿它做任何放行 / 计价 / 门禁判断**：头是客户端写的，谁都能伪造；
//   2.62 及更早的包一个都不带（没带 ≠ 有问题）。哪天要按版本拦老包（最低版本 / 强制更新），在更新清单那一侧
//   （routes/appRelease 下发的 latest.json）让 App 自己拦，不靠这一位。
// ★ 跨域：App 的 WebView 源是 https://localhost，打 api 是跨域的；带自定义请求头的请求浏览器先发 OPTIONS 预检。
//   app.js 的 cors() **没写 allowedHeaders = 原样反射预检里要的头**（cors 包的缺省行为），所以这个头天然放行。
//   ⚠ 哪天给 cors() 写死 allowedHeaders，**必须把 X-App-Version 列进去**（还有 Authorization / Content-Type 等现有的头）——
//   漏了的症状是 2.63 起**每一个**请求的预检都被拒、App 整个连不上服务器（tests/appVersion.spec.js 钉着）。
// ★ 解析失败不报错、不拒请求：日志用的东西，坏了也只是少一行日志。

/** 头值上限：正常的不到 20 个字符；超长的直接当没带（防着有人往日志里灌东西） */
const RAW_MAX = 40;
/** versionName 以数字开头，后面只许字母数字、点、横线（覆盖 `2.63` / `2.63-debug`）；versionCode 是正整数 */
const VERSION_RE = /^(\d[\w.-]{0,23})\+(\d{1,9})$/;

/**
 * 解析一个版本头的值。判据只有这一处（铁律六）。
 * @param {unknown} value
 * @returns {{ name: string, code: number, raw: string } | null}
 */
function parseAppVersion(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > RAW_MAX) return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return { name: m[1], code: Number(m[2]), raw };
}

/** Express 中间件：挂 req.appVersion（null = 没带或写法不对） */
function appVersion(req, _res, next) {
  req.appVersion = parseAppVersion(req.get("X-App-Version"));
  next();
}

module.exports = { appVersion, parseAppVersion };
