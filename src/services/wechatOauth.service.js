// 微信开放平台（api.weixin.qq.com）的授权码兑换。与 qqOauth.service 同构：
// App 原生 SDK 拿一次性 code，POST 给我们，服务端拿 AppSecret 换 openid。
//
// ★★ openid 只能由服务端换，客户端报上来的一律不认 —— 理由与 QQ 完全一致：
//   收客户端的 openid 就是"报谁的 openid 就登谁的号"。
// ★★ 微信的错误也**不体现在 HTTP 状态码上**：失败照样 200，错误在 body 的
//   errcode/errmsg 里（QQ 是 error/error_description，一家一个叫法，坑是同一个）。
// ★ AppSecret 是密钥，只准待在服务端环境变量（WECHAT_APP_SECRET）。
//   AppID（wx2b628676d9f7ac75）是公开的，随 App 一起发。
//
// 身份标识用 **unionid 优先、openid 兜底**：开放平台移动应用的授权回包带 unionid，
// 它在同一主体的多个应用间稳定（将来若加小程序/公众号登录，同一个人还能认出来）；
// openid 是按应用隔离的。两者都由微信直接告诉服务端，客户端同样伪造不了。

const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

const API_BASE = "https://api.weixin.qq.com";
const TIMEOUT_MS = 8000;

function appId() {
  return String(process.env.WECHAT_APP_ID || "").trim();
}
function appSecret() {
  return String(process.env.WECHAT_APP_SECRET || "").trim();
}

/** 两个都配齐才算开，半配当没配（preflight 会把半配报出来） */
function wechatLoginEnabled() {
  return !!appId() && !!appSecret();
}

function fail(message, status = 400, code = CODES.VALIDATION_ERROR) {
  return new AppError({ code, status, message });
}

async function wxGet(path, params) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw fail(`连接微信服务器失败：${e?.message || e}`, 502, CODES.SERVER_ERROR);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw fail("微信返回了无法解析的内容", 502, CODES.SERVER_ERROR);
  }
  // 失败是 200 + errcode。errcode 为 0 或缺省都算成功（成功回包大多不带这个字段）
  if (data.errcode) {
    throw fail(`微信授权失败（${data.errcode}）${data.errmsg || ""}`, 400, CODES.VALIDATION_ERROR);
  }
  return data;
}

/**
 * 一次性 code → { wxid, openid, accessToken }。
 * wxid 是我们落库的身份标识（unionid 优先，见文件头）；openid 留着给 userinfo 用。
 */
async function exchangeCodeForIdentity(code) {
  if (!wechatLoginEnabled()) throw fail("本服务器未开启微信登录", 503, CODES.SERVER_ERROR);
  const c = String(code || "").trim();
  if (!c) throw fail("缺少微信授权码");

  const tok = await wxGet("/sns/oauth2/access_token", {
    appid: appId(),
    secret: appSecret(),
    code: c,
    grant_type: "authorization_code",
  });

  const accessToken = String(tok.access_token || "");
  const openid = String(tok.openid || "");
  if (!accessToken || !openid) throw fail("微信未返回 access_token/openid");

  const wxid = String(tok.unionid || "") || openid;
  return { wxid, openid, accessToken };
}

/**
 * 取昵称与头像，尽最大努力：失败一律返回空对象，不挡登录（与 QQ 同一取舍）。
 * ★ headimgurl 微信文档明说可能是 http:// —— WebView 跑在 https://localhost 上，
 *   http 图片属于混合内容会被静默丢弃（QQ 头像真机踩过的同一坑），存库前升 https。
 */
async function fetchProfile(accessToken, openid) {
  try {
    const p = await wxGet("/sns/userinfo", { access_token: accessToken, openid, lang: "zh_CN" });
    return {
      nickname: String(p.nickname || "").trim().slice(0, 40),
      avatarUrl: toHttps(String(p.headimgurl || "").trim()),
    };
  } catch {
    return {};
  }
}

function toHttps(url) {
  return url.startsWith("http://") ? "https://" + url.slice("http://".length) : url;
}

module.exports = { wechatLoginEnabled, exchangeCodeForIdentity, fetchProfile };
