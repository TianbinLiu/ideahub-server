// src/routes/oauth.routes.js
//
// 第三方登录：Google / GitHub 走 passport 的「跳转 → 回调」；QQ / 微信走原生 SDK 的一次性 code（见下面两段，形状不同别照抄）。
//
// ★ 回程回带 App 的一次性 state（2026-10-15，教材人格评审 owasp-security-1）：App 发起登录时在 `/oauth/google?state=…` 带一串
//   它自己现生成的一次性字符串，我们把它签进自己的 OAuth state（`app` 字段），成功 / 失败的回跳都原样回带（`state=` 查询参数），
//   网页落点 `/oauth/callback?…` 与深链落点 `ideahub://oauth?…` 都带。
//   为什么：回 App 的深链 `ideahub://oauth?token=…` 手机上**任何一个 App 都发得出**。不回带的话，攻击者的 App 只要拼一条带
//   自己账号 token 的深链扔过去，受害者的 App 就把登录态换成攻击者的（登录 CSRF：之后受害者发的作品、充的值都落在攻击者名下，
//   全程零报错）。App 比对自己发出的那一份，对不上就丢掉。形状、为什么不 400：见 appStateOf。
// ★ 失败也回到 App（2026-10-19，2.63 发版后验证 oauth-4b）：用户在 provider 那边点「取消」、provider 报错、或在那边耽搁超过
//   state 的 10 分钟，原来一律落到官网的错误页（failureRedirect 是写死的一串），原生 App 的用户停在系统浏览器里、App 什么都收不到。
//   现在这几种失败统一从 failBack 出去：App 发起的回 `ideahub://oauth?error=…&state=…`，网页发起的与原来逐字节相同。
//   App 下一版要把「回程没带 state」改成拒（App 仓 data/oauthState 的 ⚠ 那一支），到那时只有带着 state 回来的失败才会上屏 ——
//   所以先发这一版服务端。老 App（2.62 及更早，起跳不带 state）的取消 / 出错也回到 App 了，只是不带 state（它们本来也不认）。
// ★ state 还要是签给**这一家**的（2026-10-20，生产验证 #119 后补的纵深防御）：签进去的 provider 与回调那一家对不上 =
//   不是这一跳的 state —— 失败不回 App、成功不登录也不绑定（stateFromOtherProvider）。

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = require("express").Router();
const passport = require("passport");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { logSafe } = require("../utils/logSafe");
const { signToken, signOauthState, verifyOauthState } = require("../utils/jwt");
const { grantSignupBonus } = require("../services/points.service");
const { qqLoginEnabled, exchangeCodeForOpenid, fetchProfile } = require("../services/qqOauth.service");
const wechatOauth = require("../services/wechatOauth.service");

function safeUsername(base) {
  return String(base || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20) || "user";
}

async function makeUniqueUsername(base) {
  const stem = safeUsername(base);
  let candidate = stem;
  let i = 0;
  while (await User.findOne({ username: candidate })) {
    i += 1;
    candidate = `${stem}${i}`;
    if (candidate.length > 24) candidate = `${stem.slice(0, 18)}${i}`;
  }
  return candidate;
}

/**
 * QQ 用户的用户名：随机，不从昵称派生（理由见 /oauth/qq/native 里的注释）。
 * 与 authOtp.controller 的 makeUniquePhoneUsername 是同一套做法。
 */
async function makeUniqueQqUsername() {
  for (let i = 0; i < 20; i++) {
    const candidate = `user_${crypto.randomBytes(4).toString("hex")}`;
    if (!(await User.findOne({ username: candidate }).lean())) return candidate;
  }
  // 4 字节随机撞 20 次基本不可能；真到这儿说明库里有别的问题，别静默塞一个撞名的进去
  throw new AppError({ code: CODES.SERVER_ERROR, status: 500, message: "生成用户名失败，请重试" });
}

// ---- next / state helpers ----

/**
 * 安卓/iOS App 的深链回跳目标（形如 `ideahub://oauth`），由 APP_OAUTH_SCHEME 配置。
 *
 * 为什么需要它：Google 对**嵌入式 WebView** 的授权请求一律返回 disallowed_useragent
 * （反钓鱼策略，绕不过）。所以 App 必须把授权页交给系统浏览器，登完之后没法再回到
 * WebView 里的某个路径——只能靠自定义 scheme 把人送回 App。
 *
 * ★ 只认【完全相等】，不做前缀匹配：`startsWith(scheme + "://")` 这种写法会放行
 *   `ideahub://oauth@evil.com/`、`ideahub://oauth.evil.com` 之类，等于把上面辛苦堵住的
 *   开放重定向从另一个门放回来。App 只会发这一个固定串，没有放宽的理由。
 * ★ 不配 APP_OAUTH_SCHEME 就整个特性关闭（返回空串，isAppTarget 恒 false），
 *   纯 Web 部署不会因为多了这段代码而多出一个可跳转的目标。
 */
function appRedirectTarget() {
  const scheme = String(process.env.APP_OAUTH_SCHEME || "").trim();
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return "";
  return `${scheme}://oauth`;
}

function isAppTarget(next) {
  const t = appRedirectTarget();
  return !!t && String(next || "") === t;
}

function safeNextPath(next) {
  if (!next) return "/";
  const s = String(next);
  // App 深链是唯一被允许的非 "/" 开头目标（严格等值，见 appRedirectTarget 的说明）
  if (isAppTarget(s)) return s;
  if (!s.startsWith("/")) return "/";
  // "//evil.com" 是协议相对 URL；"/\evil.com" 被多数浏览器等同处理（反斜杠当斜杠）。
  // 两者都会让 next 变成站外跳转 —— 开放重定向是钓鱼的标配跳板。
  if (s.startsWith("//") || s.startsWith("/\\")) return "/";
  // 控制字符（含 %09/%0a 之流解码后的形态）可被用来把上面的前缀检查绕过去
  if (/[\u0000-\u001f\u007f]/.test(s)) return "/";
  return s;
}

function encodeState(obj) {
  return signOauthState(obj || {});
}

/**
 * 解析 OAuth state。★验签失败一律返回 null，【绝不】回退到无签名的 base64 解码。
 *
 * 曾经这里有一条 `catch { JSON.parse(base64url(s)) }` 的回退，它让 signOauthState
 * 的签名彻底失效，构成一条无需登录的完整账号接管链：
 *   攻击者自造 state={mode:"link", linkUserId:"<受害者 ObjectId>"} → 走一遍
 *   /oauth/google/link（该端点拿不到 Authorization 头，只能靠 state 自证身份）
 *   → callback 信任 linkUserId，把攻击者的 Google 绑到受害者账号并签发受害者的 JWT。
 * 受害者 ObjectId 在 /api/users/:id、作者字段等公开面上唾手可得。
 *
 * 现在 state 只能由 POST /oauth/link/start（requireAuth）签发，10 分钟有效——
 * 签名本身就是这条链路的身份凭证，故【不可】再放宽。
 */
function decodeState(s) {
  if (!s) return null;
  try {
    return verifyOauthState(String(s));
  } catch {
    return null;
  }
}

/**
 * 失败回程专用：认「这串是不是我们签的 state」，**不管过没过期**。只用来决定失败送回哪儿（App 深链还是官网），
 * 从不拿它登录 / 绑定 —— 那两件仍只认上面的 decodeState（签名对 + 没过期）。
 * ★ 为什么过期的也认：签名对 = 这串是我们发出去的，next / app 是签发那一刻写进去的。过期只影响「还能不能登录」，
 *   不影响「把失败送回原处」：起跳端点不用登录就能签一张新的（`/oauth/google?next=…&state=…`），过期那张不比新签的
 *   多给谁一点能力；失败回程里也没有 token。而「在 provider 那边耽搁超过 10 分钟」恰恰是最该把人送回 App 的一种失败。
 * ★ 签名不对 / 不是 JWT / alg 不对 / purpose 不对（同一把密钥签的登录 token）一律 null。
 * ★ 「签名对、只是过期」靠 jsonwebtoken 的验证顺序认：verify.js 先查 alg、再验签（不对 → JsonWebTokenError），
 *   都过了才看 exp（过了 → TokenExpiredError；9.0.3 的 verify.js 第 168~190 行）。所以 TokenExpiredError = 签名已经验过。
 *   密钥 / 算法仍只在 utils/jwt.verifyOauthState 一处；这里只补 purpose 那一条（过期时它走不到自己的 purpose 判断）。
 */
function decodeStateForFail(s) {
  if (!s) return null;
  try {
    return verifyOauthState(String(s));
  } catch (e) {
    if (!e || e.name !== "TokenExpiredError") return null;
  }
  const payload = jwt.decode(String(s));
  return payload && typeof payload === "object" && payload.purpose === "oauth-state" ? payload : null;
}

/**
 * App 发起登录时自带的一次性 state（`?state=`）。只认 8～128 位 URL 安全字符（`APP_STATE_RE`），
 * 签进我们的 state 当 `app` 字段，回跳时原样回带 —— 理由见文件头。
 * ★ 不合形状的**静默忽略**（当没带），不是 400：2.62 及更早的 App 一个都不带（2.63 起才带；这里原来写成「2.63 及更早」，
 *   v2.63 的 utils/oauth.ts 已经在起跳时生成 state），拒了等于把老包全部挡在门外；
 *   而它只是回带给 App 自己比对的一串字符，服务端对它一个判断都不做（与 X-App-Version 同一条纪律）。
 * ★ 「认不认这个值」只有这一处实现：发起时签进去前过一遍，回调时从签好的 state 里取出来再过一遍（铁律六）——
 *   state 是我们自己签的，第二遍只是让「回带的东西永远只会是这个形状」不依赖签发那一侧的记忆。
 * ★ 失败那几跳也回带（2026-10-19 起，见 failBack）：provider 的错误回调照 RFC 6749 §4.1.2.1 是带着 state 回来的，原来是
 *   写死的 failureRedirect（`/api/auth/oauth/fail?provider=…`）把它丢了 —— 不是「state 已经不在手里」（这句原来写错了）。
 *   `/api/auth/oauth/fail` 本身仍不回带：那一跳的查询串里只有 provider，谁往后面拼一个 state= 都没签过名。
 * @returns {string} 合形状的原串；不合 / 没带 → ""
 */
const APP_STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;
function appStateOf(value) {
  return typeof value === "string" && APP_STATE_RE.test(value) ? value : "";
}

function getClientBase() {
  return process.env.CLIENT_BASE_URL || "http://localhost:5173";
}

function getServerBase() {
  return process.env.SERVER_BASE_URL || "http://localhost:4000";
}

function getAvailableOauthProviders() {
  const providers = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.push("github");
  }
  return providers;
}

/**
 * 拼回跳地址。两个落点二选一：
 *   Web  —— `CLIENT_BASE_URL/oauth/callback?…&next=<站内路径>`
 *   App  —— `ideahub://oauth?…`（深链，见 appRedirectTarget）
 * ★ 回 App 时不再带 next：目标已经由 scheme 唯一确定，再塞一个站内路径进去
 *   只会让 App 侧多一个需要校验的输入。
 */
function buildRedirect(nextPath, params) {
  const app = isAppTarget(nextPath);
  const url = app ? new URL(appRedirectTarget()) : new URL(`${getClientBase()}/oauth/callback`);
  if (!app) url.searchParams.set("next", safeNextPath(nextPath));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// 三个回跳都把 App 自带的一次性 state（res.locals.oauthAppState，两个登录回调解开 state 后写）当 `state=` 回带；
// 没有（老 App / 网页 / 绑定流）就是空串，buildRedirect 跳过空值 —— 不会多出一个空的 state=。理由见 appStateOf。
function redirectSuccess(res, token, nextPath) {
  return res.redirect(buildRedirect(nextPath, { token, state: res.locals.oauthAppState }));
}

/**
 * 绑定成功。★不再回传 token —— 绑定是「已登录用户给账号加一种登录方式」，
 * 本来就不需要换发会话；而回传 token 会让「谁能触发绑定」直接等价于「谁能拿到该账号的会话」，
 * 一旦 state 校验有任何闪失就是账号接管。前端 OAuthCallbackPage 在无 token 时走 refreshMe()。
 */
function redirectLinkSuccess(res, provider, nextPath) {
  return res.redirect(buildRedirect(nextPath, { linked: String(provider), state: res.locals.oauthAppState }));
}

function redirectFail(res, error, message, nextPath) {
  return res.redirect(
    buildRedirect(nextPath, {
      error: String(error || "oauth_failed"),
      message: message ? String(message) : "",
      state: res.locals.oauthAppState,
    }),
  );
}

/** passport 的 fail 原来固定去的那一跳（落到官网 /oauth/callback?next=/），网页发起的失败照旧走它 */
function webFailUrl(provider) {
  return `/api/auth/oauth/fail?provider=${provider}`;
}

/**
 * 签进 state 的 provider 与这一跳回调的 provider 对不上 → 这张 state 不是给这一跳的，当「不是我们的」处理。
 * ★ 为什么要查（2026-10-20，生产验证 #119 时发现；纵深防御）：起跳（/oauth/google|github）与绑定（/oauth/link/start）签 state
 *   时都写了 provider，而两个回调原来从不看它 —— 一张 Google 起跳签的 state 拿到 GitHub 的回调上照样认：失败照常回 App、
 *   带 code 的照常登录 / 绑定。今天构不成能用的攻击（失败回程里没有 token；成功那一支要攻击者手里有受害者自己 10 分钟内签的
 *   state，那张 state 在它自己那家本来就能用），但「这张 state 是哪一家的」签在名里、却没有任何地方核对，等于一个不作数的字段。
 * ★ 合法流程永远同一家进、同一家出：起跳签的 provider 就是这条路由的 provider，passport 注册的 callbackURL 也是同一家；
 *   绑定票的 provider 决定 redirectUrl 走哪一家的 /link、再回哪一家的回调。所以对不上只可能是被人挪过去的。
 * ★ 没写 provider 的照旧认（缺省 = 认）：2026-02-13 起每一处签发都写了、签出去 10 分钟就过期，按说早就一张都没有了 ——
 *   但「没写就拒」在这里买不到什么（签名照样要对），收紧反而要先证明没有漏网的签发点。
 * ★ 两处用它（铁律六，规则只在这一处）：failBack（失败往哪儿送）与两个登录回调的成功那一支（拿不拿它登录 / 绑定）。
 */
function stateFromOtherProvider(st, provider) {
  return !!st && st.provider !== undefined && st.provider !== provider;
}

/**
 * 走不到「拿 provider 交回来的人登录」那一步的失败，统一从这里出去：provider 拒了（取消授权）/ 报了别的错 / 换 token 失败，
 * 以及我们自己的 state 验不过（过期、签名不对、签给了另一家）。
 * ★ App 发起的回到 App：state 的签名认得出（decodeStateForFail，过期的也算）、签的是这一家（stateFromOtherProvider），
 *   签进去的 next 再过一遍 safeNextPath 之后**正是** App 深链（isAppTarget，严格等值）⇒
 *   `ideahub://oauth?error=oauth_failed&message=…&state=<app>`；app 不合 APP_STATE_RE（appStateOf 第二遍）就不带 state。
 *   回程地址只经 buildRedirect 拼 —— 没有新开任何跳转目标。
 * ★ 其余一律 `onWeb()`，也就是改之前那一跳（调用方给）：网页发起的（next 是站内路径）结果逐字节不变；签名不对 / 根本不是
 *   我们的 state / 签给了另一家也走这里、一个字都不回带 —— 它签进去说的「回 App」我们没法作保。走 onWeb 之前把
 *   res.locals.oauthAppState 清掉：「不回带」由这里保证，不靠调用方记得别先写它（redirectStateFail 的 onWeb 会读它）。
 * ★ message 只用我们自己的固定文案：provider 的 error_description 不进 URL（那段字是 provider 或发链接的人写的，
 *   App 会把 message 原样摆上屏）。
 */
function failBack(req, res, provider, message, onWeb) {
  const st = decodeStateForFail(req.query.state);
  const nextPath = st && !stateFromOtherProvider(st, provider) ? safeNextPath(st.next) : "/";
  if (!isAppTarget(nextPath)) {
    res.locals.oauthAppState = "";
    return onWeb();
  }
  res.locals.oauthAppState = appStateOf(st.app);
  return redirectFail(res, "oauth_failed", message, nextPath);
}

/**
 * 两个登录回调里「我们的 state 验不过」那一支：签名对、只是过期（在 provider 那边耽搁超过 10 分钟）且是 App 发起的 → 回 App；
 * 其余（签名不对、签给了另一家）与原来一样落官网、不回带。不让它登录：过期的 state 只用来认「送回哪儿」。
 */
function redirectStateFail(req, res, provider) {
  const message = "Invalid or expired OAuth state";
  return failBack(req, res, provider, message, () => redirectFail(res, "oauth_failed", message, "/"));
}

/**
 * passport-oauth2 在「换 token 那一发回了 2xx、里面却没有 access_token」时交出来的那一个**裸 Error**
 * （1.8.0 的 lib/strategy.js 第 178 行：`self.error(new Error('Failed to obtain access token'))`；同一句话的上一行
 *   —— 换 token 回了非 2xx —— 走 `_createOAuthError`，是带类型的 TokenError / InternalOAuthError，不归这里管）。
 * ★ 为什么单认它（2026-10-20，生产验证 #119 时打出来的）：GitHub 对坏的 / 用过的 code 回的正是 HTTP 200 +
 *   `{"error":"bad_verification_code",…}`，node-oauth 照 2xx 当成功、access_token 取到 undefined，于是走到这一行。
 *   它是 provider 那边的结局，而且谁都打得出来：不用登录，起跳签一张新 state，再拿一个瞎编的 code 打 GitHub 的回调。
 *   原来它落进下面「意外错误」那一支，每打一次就往 pm2 错误日志里写一整份堆栈 —— 真正的意外被噪音淹掉，也是一个现成的刷日志口子。
 * ★ 只认这**一个**：构造器恰是 Error、name 是 "Error"、message 逐字相等。不放宽成「所有裸 Error」—— 我们自己代码里出来的
 *   裸 Error（verify 回调、取资料里的 bug）照旧整份带堆栈（middleware/error.js 的 ★★「500 必须落堆栈」）。
 *   升级 passport-oauth2 时重核这句原话：改了措辞，它只会退回「意外错误」那一支（多一份堆栈），不会被吞掉。
 * ⚠ 同一句话也是**我们自己配错了**的样子：GITHUB_CLIENT_SECRET 轮换错了 / 回调地址对不上时，GitHub 同样回 200 +
 *   `incorrect_client_credentials` / `redirect_uri_mismatch`，也落到这一行。所以「`Error no_access_token` 偶尔一条」是有人瞎打，
 *   「每一次 GitHub 登录都是它」是故障 —— 排障时别把一串这种行当噪音略过（原来的堆栈也只指向 strategy.js 这一行，没丢信息）。
 */
const NO_ACCESS_TOKEN_MESSAGE = "Failed to obtain access token";
function isNoAccessTokenError(err) {
  return !!err && err.constructor === Error && err.name === "Error" && err.message === NO_ACCESS_TOKEN_MESSAGE;
}

/**
 * 回调那一跳交给 passport 的写法（Google / GitHub 共用）：provider 交回来一个人 → 挂到 req.user 上交给下一棒
 * （与原来 `session: false` 时 passport 自己做的一样：req.login 不开 session 时就只是 req.user = user）；
 * 交不回来（fail：provider 拒了）或出错（error：provider 回了 access_denied 以外的错、换 token / 取资料失败）→ failBack。
 * ★ 为什么不再用 `failureRedirect`：它是写死的一串，passport 走到它时不看 state，App 发起的失败只能落在官网。
 * ★ access_denied 以外的 error（server_error / temporarily_unavailable / admin_policy_enforced …）passport-oauth2 走
 *   this.error(AuthorizationError)，原来进全局错误处理回一段 JSON 的 5xx —— 原生 App 用户在系统浏览器里看到一段 JSON。
 *   现在当登录失败送回去，原因记一行日志（只记类型 / 码 / 状态，不记 code、state）。
 * ★ 不带 code 也不带 error 的请求，passport 当起跳、302 去 provider（strategy.redirect，不经这个回调），与原来一样。
 */
function oauthCallback(provider) {
  return (req, res, next) =>
    passport.authenticate(provider, { session: false }, (err, user) => {
      if (err) {
        // ★ provider 那边的四种 —— passport-oauth2 的 AuthorizationError / TokenError / InternalOAuthError，外加换 token 回了 2xx
        //   却没有 access_token 的那一个裸 Error（isNoAccessTokenError，码记成我们自己的 no_access_token）—— 只记一行类型 / 码 / 状态：
        //   AuthorizationError 的 code 就是回调查询串里的 error，谁都能填 —— 过 logSafe（去换行、限长），否则一个换行就伪造出整行假日志。
        //   没有码 / 状态的那一格写 "-"，一行永远是同样几格。
        //   别的（TypeError 之类，我们自己的错）照 middleware/error.js 的 ★★「500 必须落堆栈」整份打出来：原来它们进全局错误处理时
        //   有堆栈，改成送回 App 之后不能把排障线索一起吞掉（10-19 复核抓到）。
        const noToken = isNoAccessTokenError(err);
        if (noToken || /^(AuthorizationError|TokenError|InternalOAuthError)$/.test(err.name || "")) {
          console.warn(
            `[oauth] ${provider} 回调出错，按登录失败送回: ${logSafe(err.name, 40)} ${logSafe(err.code || (noToken ? "no_access_token" : "-"), 64)} ${logSafe(err.status || err.oauthError?.statusCode || "-", 8)}`,
          );
        } else {
          console.error(`[oauth] ${provider} 回调里的意外错误，按登录失败送回:`, err);
        }
      }
      if (err || !user) {
        return failBack(req, res, provider, `${provider} login failed`, () => res.redirect(webFailUrl(provider)));
      }
      req.user = user;
      return next();
    })(req, res, next);
}

function getOauthConflictMessage(provider) {
  return `${provider} email is already linked to another IdeaHub login method. Please use the original sign-in method for that account.`;
}

function getOauthAlreadyLinkedMessage(provider) {
  return `${provider} is already linked to a different third-party account on this IdeaHub profile.`;
}

function countLoginMethods(user) {
  const passwordCount = user?.passwordHash ? 1 : 0;
  const googleCount = user?.providers?.google ? 1 : 0;
  const githubCount = user?.providers?.github ? 1 : 0;
  // ★ QQ 也算一种登录方式。漏掉它的后果是"只有 QQ + Google 的用户解绑不了 Google"——
  //   我们会以为他解绑后就没法登录了，其实 QQ 还在。这类"新 provider 没搬全"的漏改
  //   一律零报错，只是行为悄悄错一档。
  const qqCount = user?.providers?.qq ? 1 : 0;
  const wechatCount = user?.providers?.wechat ? 1 : 0;
  return passwordCount + googleCount + githubCount + qqCount + wechatCount;
}

function buildOauthLinksPayload(user) {
  const linkedProviders = {
    google: Boolean(user?.providers?.google),
    github: Boolean(user?.providers?.github),
    qq: Boolean(user?.providers?.qq),
    wechat: Boolean(user?.providers?.wechat),
  };

  return {
    ok: true,
    availableProviders: getAvailableOauthProviders(),
    hasPassword: Boolean(user?.passwordHash),
    linkedProviders,
    canUnlink: {
      google: linkedProviders.google && countLoginMethods(user) > 1,
      github: linkedProviders.github && countLoginMethods(user) > 1,
      qq: linkedProviders.qq && countLoginMethods(user) > 1,
      wechat: linkedProviders.wechat && countLoginMethods(user) > 1,
    },
  };
}

router.get("/oauth/links", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("providers passwordHash").lean();
    res.json(buildOauthLinksPayload(user));
  } catch (err) {
    next(err);
  }
});

router.delete("/oauth/links/:provider", requireAuth, async (req, res, next) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    // qq 也可解绑：countLoginMethods 那道闸门保证不会把人锁在门外
    // （QQ 用户的邮箱是合成的、也没有密码，真解绑成最后一种方式就再也进不来了）
    if (!["google", "github", "qq", "wechat"].includes(provider)) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Invalid OAuth provider",
      });
    }

    const user = await User.findById(req.user._id).select("providers passwordHash");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    if (!user.providers?.[provider]) {
      throw new AppError({
        code: CODES.OAUTH_NOT_LINKED,
        status: 400,
        message: `${provider} is not linked to this account`,
      });
    }

    if (countLoginMethods(user) <= 1) {
      throw new AppError({
        code: CODES.OAUTH_UNLINK_LAST_METHOD,
        status: 400,
        message: "You must keep at least one login method on your account",
      });
    }

    user.providers[provider] = "";
    await user.save();

    res.json(buildOauthLinksPayload(user.toObject()));
  } catch (err) {
    next(err);
  }
});

router.post("/oauth/link/start", requireAuth, async (req, res, next) => {
  try {
    const provider = String(req.body?.provider || "").toLowerCase();
    const nextPath = safeNextPath(req.body?.next || "/me");
    const availableProviders = getAvailableOauthProviders();

    if (!availableProviders.includes(provider)) {
      res.status(400);
      throw new Error("OAuth provider is not available");
    }

    const state = encodeState({
      mode: "link",
      provider,
      next: nextPath,
      linkUserId: req.user._id.toString(),
    });

    const redirectUrl = new URL(`${getServerBase()}/api/auth/oauth/${provider}/link`);
    redirectUrl.searchParams.set("state", state);

    res.json({ ok: true, redirectUrl: redirectUrl.toString() });
  } catch (err) {
    next(err);
  }
});

/**
 * 绑定入口。★不能挂 requireAuth —— 这是浏览器顶层跳转，带不了 Authorization 头
 * （token 在前端 localStorage 里）。身份改由 state 的签名承担：先在这里验一次，
 * 伪造/过期的 state 当场打回，不进 passport、也不给 provider 发请求
 * （否则这个端点就成了一个无鉴权的对外跳转器）。
 */
function linkStart(strategy, options) {
  return (req, res, next) => {
    const raw = String(req.query.state || "");
    const st = decodeState(raw);
    if (!st || st.mode !== "link" || !st.linkUserId) {
      return redirectFail(res, "oauth_failed", "Invalid or expired link request", "/me");
    }
    passport.authenticate(strategy, { session: false, ...options, state: raw })(req, res, next);
  };
}

router.get("/oauth/google/link", linkStart("google", { scope: ["profile", "email"], prompt: "select_account" }));

router.get("/oauth/github/link", linkStart("github", {}));

// ---------------- Google ----------------
router.get("/oauth/google", (req, res, next) => {
  const nextPath = safeNextPath(req.query.next);
  // App 自带的一次性 state 签进去（合形状才签；没带 / 不合 = 老 App，键也不出现），见 appStateOf
  const app = appStateOf(req.query.state);
  const state = encodeState({ next: nextPath, provider: "google", ...(app ? { app } : {}) });

  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
    prompt: "select_account",
    state,
  })(req, res, next);
});

router.get(
  "/oauth/google/callback",
  oauthCallback("google"),
  async (req, res) => {
    const st = decodeState(req.query.state);
    // 登录流的 state 同样由我们签发（/oauth/google 里 encodeState），故解析失败 = 被篡改或过期，直接打回、不登录
    // （只是过期、又是 App 发起的那种送回 App，见 redirectStateFail）。签名对、却是签给另一家的（stateFromOtherProvider：
    // 合法流程同一家进同一家出）同样打回 —— 不拿它登录、不拿它绑定。
    if (!st || stateFromOtherProvider(st, "google")) return redirectStateFail(req, res, "google");
    // App 自带的 state 从签好的 state 里取出来，成功 / 失败的回跳都回带（redirectSuccess / redirectFail 从 res.locals 读）。
    // ★ 写在上面那道闸**之后**：验不过的 state 我们没法替它作保，一个字都不回带（failBack 走网页那一支也会再清一次）。
    res.locals.oauthAppState = appStateOf(st.app);
    const nextPath = safeNextPath(st.next);

    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing google profile", nextPath);

      const googleId = profile.id;
      const emails = profile.emails || [];
      const email = (emails[0]?.value || "").toLowerCase();
      const avatarUrl = profile.photos?.[0]?.value || "";

      if (!email) return redirectFail(res, "oauth_failed", "Google email not available", nextPath);

      if (st.mode === "link") {
        const linkUserId = String(st.linkUserId || "");
        if (!linkUserId) {
          return redirectFail(res, "oauth_failed", "Missing link user", nextPath);
        }

        const linkUser = await User.findById(linkUserId);
        if (!linkUser) {
          return redirectFail(res, "oauth_failed", "Link target user not found", nextPath);
        }

        const providerOwner = await User.findOne({ "providers.google": googleId });
        if (providerOwner && providerOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
        }

        const emailOwner = await User.findOne({ email });
        if (emailOwner && emailOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
        }

        if (linkUser.providers.google && linkUser.providers.google !== googleId) {
          return redirectFail(res, "oauth_conflict", getOauthAlreadyLinkedMessage("Google"), nextPath);
        }

        linkUser.providers.google = googleId;
        if (!linkUser.avatarUrl && avatarUrl) linkUser.avatarUrl = avatarUrl;
        linkUser.emailVerified = true;
        await linkUser.save();

        return redirectLinkSuccess(res, "google", nextPath);
      }

      let user = await User.findOne({ "providers.google": googleId });

      if (!user) {
        const existingUserWithEmail = await User.findOne({ email });
        if (existingUserWithEmail) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
        }
      }

      if (!user) {
        const usernameBase = profile.displayName || email.split("@")[0];
        const username = await makeUniqueUsername(usernameBase);

        user = await User.create({
          username,
          email,
          passwordHash: "",
          role: "user",
          bio: "",
          providers: { google: googleId, github: "" },
          avatarUrl,
          emailVerified: true,
        });

        // 注册赠送虚拟点数（唯一的印钱口）。★只在这一支【新建用户】里调用：
        // 上面 findOne 命中的是既有用户（他们的余额走 backfillPoints 补），
        // st.mode === "link" 那一支是给已有账号绑第三方登录，都不能再赠送一次。
        await grantSignupBonus(user._id);
      }

      const token = signToken(user);
      return redirectSuccess(res, token, nextPath);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "Google callback error", nextPath);
    }
  }
);

// ---------------- GitHub ----------------
router.get("/oauth/github", (req, res, next) => {
  const nextPath = safeNextPath(req.query.next);
  // 与 /oauth/google 同一句：App 自带的一次性 state 签进去（见 appStateOf）
  const app = appStateOf(req.query.state);
  const state = encodeState({ next: nextPath, provider: "github", ...(app ? { app } : {}) });

  passport.authenticate("github", { session: false, state })(req, res, next);
});

router.get(
  "/oauth/github/callback",
  oauthCallback("github"),
  async (req, res) => {
    const st = decodeState(req.query.state);
    // 与 google callback 同两句（理由见那里）：验不过 / 签给另一家的打回，过了闸才取 App 自带的 state 回带给成功 / 失败两种回跳
    if (!st || stateFromOtherProvider(st, "github")) return redirectStateFail(req, res, "github");
    res.locals.oauthAppState = appStateOf(st.app);
    const nextPath = safeNextPath(st.next);

    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing github profile", nextPath);

      const githubId = profile.id;
      const avatarUrl = profile.photos?.[0]?.value || "";
      const email = (profile.emails?.[0]?.value || "").toLowerCase();

      if (st.mode === "link") {
        const linkUserId = String(st.linkUserId || "");
        if (!linkUserId) {
          return redirectFail(res, "oauth_failed", "Missing link user", nextPath);
        }

        const linkUser = await User.findById(linkUserId);
        if (!linkUser) {
          return redirectFail(res, "oauth_failed", "Link target user not found", nextPath);
        }

        const providerOwner = await User.findOne({ "providers.github": githubId });
        if (providerOwner && providerOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
        }

        if (email) {
          const emailOwner = await User.findOne({ email });
          if (emailOwner && emailOwner._id.toString() !== linkUserId) {
            return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
          }
        }

        if (linkUser.providers.github && linkUser.providers.github !== githubId) {
          return redirectFail(res, "oauth_conflict", getOauthAlreadyLinkedMessage("GitHub"), nextPath);
        }

        linkUser.providers.github = githubId;
        if (!linkUser.avatarUrl && avatarUrl) linkUser.avatarUrl = avatarUrl;
        if (email) linkUser.emailVerified = true;
        await linkUser.save();

        return redirectLinkSuccess(res, "github", nextPath);
      }

      let user = await User.findOne({ "providers.github": githubId });

      if (!user && email) {
        const existingUserWithEmail = await User.findOne({ email });
        if (existingUserWithEmail) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
        }
      }

      if (!user) {
        const finalEmail = email || `github_${githubId}@no-email.ideahub.local`;
        const usernameBase = profile.username || profile.displayName || `github${githubId}`;
        const username = await makeUniqueUsername(usernameBase);

        user = await User.create({
          username,
          email: finalEmail,
          passwordHash: "",
          role: "user",
          bio: "",
          providers: { google: "", github: githubId },
          avatarUrl,
          emailVerified: !!email,
        });

        // 注册赠送虚拟点数（唯一的印钱口）。★只在这一支【新建用户】里调用，理由同 google callback。
        await grantSignupBonus(user._id);
      }

      const token = signToken(user);
      return redirectSuccess(res, token, nextPath);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "GitHub callback error", nextPath);
    }
  }
);

// ---------------- QQ（移动应用 / 原生 SDK）----------------
//
// ★★ 这条路和上面两条**不是一个形状**，别照着 google 改：
//   我们在 QQ 互联注册的是移动应用，后台没有"回调地址"那一栏，网页版 OAuth2.0 走不通。
//   App 用原生 SDK 的 loginServerSide 拿到一次性 code，POST 上来，我们在服务端换 openid。
//   ⇒ 没有 state、没有 302 回跳、没有 passport strategy，也**不出现在 capabilities.providers 里**
//     （那份列表的语义是"能跳转的 provider"，QQ 塞进去只会让 Web 端亮一个点不动的按钮）。
//
// ★ 限流按 IP，不按账号。code 是一次性且不可猜的，没有撞库面；这个闸门挡的是
//   "有人拿它当免费的 graph.qq.com 打点器" —— 每个请求都会让我们对外发一次真请求。
router.post(
  "/oauth/qq/native",
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.QQ_LOGIN_RATE_MAX || 20),
    scope: "qq-native",
  }),
  async (req, res, next) => {
    try {
      if (!qqLoginEnabled()) {
        throw new AppError({ code: CODES.SERVER_ERROR, status: 503, message: "本服务器未开启 QQ 登录" });
      }

      // ★ 只收 code。客户端**不许**送 openid 上来 —— 那等于"报谁的 openid 就登谁的号"。
      const { openid, accessToken } = await exchangeCodeForOpenid(req.body?.code);

      let user = await User.findOne({ "providers.qq": openid });
      let created = false;

      if (!user) {
        const profile = await fetchProfile(accessToken, openid); // 尽力而为，失败不挡登录
        try {
          user = await User.create({
            // ★ 用户名随机生成，不从 QQ 昵称派生：username 是公开的 @ 句柄，
            //   而昵称大多是中文，safeUsername 会把它洗成空串，于是所有 QQ 用户
            //   都去抢 user / user1 / user2 …，既撞名又要循环查很多次库。
            //   昵称放 displayName（允许重名、允许中文），与手机注册那条路同一套做法。
            username: await makeUniqueQqUsername(),
            // QQ **不给邮箱**（get_simple_userinfo 里就没有这一项），而 email 是
            // required+unique，所以走合成邮箱，与手机注册同一套。用户日后可自己补真邮箱。
            email: `qq_${openid}@no-email.ideahub.local`,
            passwordHash: "",
            role: "user",
            bio: "",
            displayName: profile.nickname || "",
            avatarUrl: profile.avatarUrl || "",
            providers: { google: "", github: "", qq: openid },
          });
          created = true;
        } catch (e) {
          // 并发：同一个人连点两下，两个请求都没查到就都去建号。
          // 后到的那个撞唯一索引（合成邮箱里带 openid，必然撞），改取已存在的那条，
          // 且**不重复赠点**。
          if (e && e.code === 11000) {
            user = await User.findOne({ "providers.qq": openid });
            if (!user) throw e;
          } else {
            throw e;
          }
        }
        // 印钱口（赠点）只接在【新建用户】这一支上，与 google / 手机号那两条一致
        if (created) await grantSignupBonus(user._id);
      }

      const token = signToken(user);
      res.status(created ? 201 : 200).json({
        ok: true,
        token,
        created,
        user: { id: user._id, username: user.username, email: user.email, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------- 微信（移动应用 / 原生 SDK）----------------
//
// 与 QQ 的 /oauth/qq/native 完全同构：App 原生 SDK 拿一次性 code，服务端拿 AppSecret
// 换身份。只收 code；身份标识 unionid 优先（见 wechatOauth.service 文件头）。
router.post(
  "/oauth/wechat/native",
  rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.WECHAT_LOGIN_RATE_MAX || 20),
    scope: "wechat-native",
  }),
  async (req, res, next) => {
    try {
      const { wxid, openid, accessToken } = await wechatOauth.exchangeCodeForIdentity(req.body?.code);

      let user = await User.findOne({ "providers.wechat": wxid });
      let created = false;

      if (!user) {
        const profile = await wechatOauth.fetchProfile(accessToken, openid); // 尽力而为
        try {
          user = await User.create({
            // 用户名随机、昵称进 displayName、邮箱合成——三条都与 QQ 建号同一套理由
            username: await makeUniqueQqUsername(),
            email: `wechat_${wxid}@no-email.ideahub.local`,
            passwordHash: "",
            role: "user",
            bio: "",
            displayName: profile.nickname || "",
            avatarUrl: profile.avatarUrl || "",
            providers: { google: "", github: "", qq: "", wechat: wxid },
          });
          created = true;
        } catch (e) {
          if (e && e.code === 11000) {
            user = await User.findOne({ "providers.wechat": wxid });
            if (!user) throw e;
          } else {
            throw e;
          }
        }
        if (created) await grantSignupBonus(user._id);
      }

      const token = signToken(user);
      res.status(created ? 201 : 200).json({
        ok: true,
        token,
        created,
        user: { id: user._id, username: user.username, email: user.email, role: user.role },
      });
    } catch (err) {
      next(err);
    }
  },
);

// 网页发起的登录失败落到这里（oauthCallback 的 webFailUrl），再一跳到官网 /oauth/callback?next=/。
// ★ 这一跳不回带 state：查询串里只有 provider，谁往后面拼一个 state= 都没签过名。App 发起的失败不经过这里 ——
//   2026-10-19 起由 failBack 直接送回 App 深链（之前也走这里、落在官网，App 什么都收不到）。
router.get("/oauth/fail", (req, res) => {
  const provider = req.query.provider || "oauth";
  return redirectFail(res, "oauth_failed", `${provider} login failed`, "/");
});

module.exports = router;
