//jwt.js

const jwt = require("jsonwebtoken");
const AppError = require("./AppError");
const CODES = require("./errorCodes");

/**
 * 签发登录 token。
 *
 * ★【已停用账号不得签发】判定放在这里、而不是各个登录入口：
 * signToken 是所有签发路径的【唯一收口】（密码登录 / OTP 重置 / OAuth 回调 /
 * 改密 / 换密 / OAuth 绑定），逐个入口去加判断迟早漏掉一个，而漏掉的后果是
 * 「注销后仍能登录成功、拿到 token、然后每个接口都 401」的死循环 ——
 * 前端还写着「账号将无法登录」，那就成了对用户撒谎。
 *
 * 注意：本判定依赖传入的 user 文档【真的加载了 deactivatedAt】。
 * 三条无需鉴权即可到达的真·登录路径（auth.controller 的 login、
 * authOtp.controller 的 reset/verify、oauth.routes 的两个 callback）都用
 * User.findOne(...) 取全量文档，故字段必在。若日后有人改用 .select(...)
 * 精简字段而漏掉 deactivatedAt，这道守卫会【静默失效】—— 加字段时务必带上它。
 * （requireAuth 那道门是真正的安全边界，此处主要保证「说到做到」与体验。）
 */
function signToken(user) {
  if (user && user.deactivatedAt) {
    throw new AppError({
      code: CODES.UNAUTHORIZED,
      status: 401,
      message: "Account deactivated",
    });
  }
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, tokenVersion: Number(user.tokenVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function signOauthState(payload) {
  return jwt.sign(
    { ...payload, purpose: "oauth-state" },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function verifyOauthState(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload?.purpose !== "oauth-state") {
    throw new Error("Invalid OAuth state");
  }
  return payload;
}

module.exports = { signToken, signOauthState, verifyOauthState };
