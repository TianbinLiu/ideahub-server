// QQ 互联（graph.qq.com）的授权码兑换。
//
// ★★ 这条链路与 google/github 那两条【形状完全不同】，别照着改：
//   google/github —— 浏览器顶层跳转 → passport 回调 → 我们拿到 profile。
//   QQ            —— 我们在 QQ 互联注册的是**移动应用**，后台**没有回调地址那一栏**，
//                    网页版 OAuth2.0 授权根本走不通。App 用原生 SDK 的
//                    loginServerSide 拿到一次性 code，POST 给我们，由本模块换 openid。
//   ⇒ 所以没有 state、没有回跳、没有 passport strategy。
//
// ★★ 为什么必须由服务端换、而不是让客户端把 openid 传上来：
//   openid 是 QQ **直接告诉服务端**的，客户端没有机会伪造。
//   要是图省事收客户端的 openid，那就是"报谁的 openid 就登谁的号"——
//   一个不需要任何凭证的完整账号接管。
//
// ★ AppKey 是密钥，只存在于服务端环境变量。AppID 是公开的（随 App 一起发出去了）。

const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

const GRAPH_BASE = "https://graph.qq.com";
/**
 * 移动应用换 token 时 redirect_uri 是个**固定占位值** —— 移动应用压根没有回调地址，
 * 但 /oauth2.0/token 这个接口的参数表是和网站应用共用的，少了它会被判 400。
 * ★ 若某天 QQ 改口返回 `redirect uri is illegal(100010)`，换成
 *   "auth://tauth.qq.com/" 再试 —— 这两个值是历史上先后出现过的两种写法。
 */
const MOBILE_REDIRECT_URI = "auth://www.qq.com";
/** QQ 偶发抽风时别把用户的登录请求挂死在这里 */
const TIMEOUT_MS = 8000;

function appId() {
  return String(process.env.QQ_APP_ID || "").trim();
}
function appKey() {
  return String(process.env.QQ_APP_KEY || "").trim();
}

/** 两个都配齐才算开。半配（只有 ID 没有 Key）当没配——见 config/preflight 里的告警 */
function qqLoginEnabled() {
  return !!appId() && !!appKey();
}

function fail(message, status = 400, code = CODES.VALIDATION_ERROR) {
  return new AppError({ code, status, message });
}

/**
 * 解析 graph.qq.com 的回包。
 *
 * ★ 这个接口的返回格式有三种，且**不由我们的参数完全决定**：
 *   ① fmt=json 正常时      → `{"access_token":"...","openid":"..."}`
 *   ② 出错时常退回 JSONP   → `callback( {"error":100016,"error_description":"..."} );`
 *   ③ 老式成功回包         → `access_token=xxx&expires_in=7776000`（application/x-www-form-urlencoded）
 *   只按 JSON.parse 写的话，②③ 会抛在 JSON 解析上，最后用户看到的是
 *   "Unexpected token c"——真正的失败原因（error_description）反而被吃掉了。
 */
function parseGraphBody(text) {
  const s = String(text || "").trim();
  if (!s) return {};

  // ② 去掉 JSONP 外壳：callback( {...} ); / callback({...})
  const jsonp = s.match(/^[A-Za-z_$][\w$]*\s*\(\s*([\s\S]*?)\s*\)\s*;?$/);
  const body = jsonp ? jsonp[1] : s;

  if (body.startsWith("{")) {
    try {
      return JSON.parse(body);
    } catch {
      return { _raw: s };
    }
  }

  // ③ querystring 形态
  if (body.includes("=")) {
    const out = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
  }
  return { _raw: s };
}

async function graphGet(path, params) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    // 超时/连不上。★ 必须报出来：静默失败的话，用户点了 QQ 登录只会看到按钮转一下就停
    throw fail(`连接 QQ 服务器失败：${e?.message || e}`, 502, CODES.SERVER_ERROR);
  }
  const data = parseGraphBody(await res.text());
  // QQ 的错误**不体现在 HTTP 状态码上**（照样 200），只能看 body 里的 error 字段。
  // 这和本仓的另一条老教训同源：永远不要只信状态码。
  if (data.error || data.error_code) {
    const code = data.error || data.error_code;
    const desc = data.error_description || data.error_msg || "";
    throw fail(`QQ 授权失败（${code}）${desc}`, 400, CODES.VALIDATION_ERROR);
  }
  return data;
}

/**
 * 一次性 code → { openid, accessToken }。
 *
 * ★ openid 的两条来路都做了，因为 need_openid 不是所有版本都给：
 *   ① /oauth2.0/token?need_openid=1 直接带回来（省一次往返）；
 *   ② 退回 /oauth2.0/me 再问一次。
 *   走 ② 时**必须核对 client_id 等于我们的 AppID** —— 否则拿着"给别的应用签发的
 *   access_token"也能过：那种 token 对应的 openid 属于别人的 openid 命名空间，
 *   等于用另一个 App 的用户身份登进我们这里。这是 OAuth 的经典 confused deputy。
 */
async function exchangeCodeForOpenid(code) {
  if (!qqLoginEnabled()) throw fail("本服务器未开启 QQ 登录", 503, CODES.SERVER_ERROR);
  const c = String(code || "").trim();
  if (!c) throw fail("缺少 QQ 授权码");

  const tok = await graphGet("/oauth2.0/token", {
    grant_type: "authorization_code",
    client_id: appId(),
    client_secret: appKey(),
    code: c,
    redirect_uri: MOBILE_REDIRECT_URI,
    fmt: "json",
    need_openid: 1,
  });

  const accessToken = String(tok.access_token || "");
  if (!accessToken) throw fail("QQ 未返回 access_token");

  let openid = String(tok.openid || "");
  if (!openid) {
    const me = await graphGet("/oauth2.0/me", { access_token: accessToken, fmt: "json" });
    // ★ 见上面 ② 的说明，这一条不能省
    if (String(me.client_id || "") !== appId()) {
      throw fail("QQ 返回的应用标识与本服务器不符", 400, CODES.VALIDATION_ERROR);
    }
    openid = String(me.openid || "");
  }
  if (!openid) throw fail("QQ 未返回 openid");

  return { openid, accessToken };
}

/**
 * QQ 的头像地址回的是 **http://**（thirdqq.qlogo.cn），必须升到 https。
 *
 * ★★ 2026-08-24 真机实测才发现的：App 的 WebView 跑在 `https://localhost` 上，
 *   一个 http 图片属于**混合内容**，Chromium 直接静默丢弃 —— 页面不报错、
 *   logcat 里也没有（release 包吞 console），表现就是"昵称有了、头像是个空占位"，
 *   看起来像 get_user_info 没取到，实际取到了、还存进库了。
 *   同一个 host 支持 https（实测 200 image/jpeg），换个协议就行。
 */
function toHttps(url) {
  return url.startsWith("http://") ? "https://" + url.slice("http://".length) : url;
}

/**
 * 取昵称与头像，**尽最大努力**：失败一律返回空对象，绝不让它挡住登录。
 * 拿不到就退到随机用户名 + 默认头像，用户随时能自己改；
 * 而为了一个装饰性字段把整条登录路打断，是明显更坏的取舍。
 */
async function fetchProfile(accessToken, openid) {
  try {
    const p = await graphGet("/user/get_user_info", {
      access_token: accessToken,
      oauth_consumer_key: appId(),
      openid,
      fmt: "json",
    });
    return {
      nickname: String(p.nickname || "").trim().slice(0, 40),
      // figureurl_qq_2 是 100×100 那档；没有就退 40×40 的 figureurl_qq_1
      avatarUrl: toHttps(String(p.figureurl_qq_2 || p.figureurl_qq_1 || "").trim()),
    };
  } catch {
    return {};
  }
}

module.exports = { qqLoginEnabled, exchangeCodeForOpenid, fetchProfile, parseGraphBody, MOBILE_REDIRECT_URI };
