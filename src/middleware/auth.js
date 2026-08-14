const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
// 「封没封 / 给用户看哪句话」只有 utils/banned.js 一处（铁律六）
const { isBanned, bannedMessage } = require("../utils/banned");

const AUTH_DEBUG_ENABLED = process.env.AUTH_DEBUG === "true";

function authDebug(...args) {
  if (AUTH_DEBUG_ENABLED) {
    console.log("[Auth]", ...args);
  }
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      authDebug("Missing or invalid Authorization header");
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Missing or invalid Authorization header",
      });
    }

    // ★ 固定算法：不写 algorithms 时 jsonwebtoken 会按 token 头部的 alg 字段来验，
    //   这正是 alg 混淆攻击的入口（如把 HS256 换成别的对称算法试探）。我们只签 HS256。
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const userId = payload.sub;

    // ★ select 里必须带 banned：漏了的话下面的封禁检查读到 undefined → 恒判「没封」，
    //   整道门静默失效且一个错都不报（与 addComment 里 select visibility 是同一形状的坑）
    const user = await User.findById(userId).select("_id username email role bio avatarUrl createdAt tokenVersion joinedGroupSlugs deactivatedAt banned");
    if (!user) {
      authDebug("User not found:", userId);
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    // 已注销（软删除）账号：一律视为未授权。
    // 放在 tokenVersion 校验【之前】，这样注销后旧 token 得到的是明确的
    // "Account deactivated" 而不是笼统的 "Session expired"。
    if (user.deactivatedAt) {
      authDebug("Account deactivated:", userId);
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Account deactivated",
      });
    }

    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Session expired. Please log in again.",
      });
    }

    // 平台封禁：403 BANNED + 可读原因（判据与文案在 utils/banned.js 一处）。
    // ★ 每次请求都从库里重读 user（见上），所以封/解封**立即生效**，不用动 tokenVersion。
    // ★ 403 而不是 401：app 对 401 的处置是「登出重登」，封禁重登也没用 ——
    //   客户端要按 BANNED 这个码把原因展示出来，而不是把人踢回登录页转圈。
    // ★★ 刻意**没有任何端点例外**（连「注销账号」「联系客服」都没有）：例外表意味着
    //   每加一条路由都要重新回答「封禁的人能不能打它」，答错不报错（多放行一条就是
    //   封禁形同虚设的口子）。封禁用户与平台的沟通走 app 外渠道（封禁文案里的原因
    //   已经说明了缘由），这是拿「体验的一点余地」换「门只有一扇」的取舍。
    if (isBanned(user)) {
      authDebug("Account banned:", userId);
      throw new AppError({
        code: CODES.BANNED,
        status: 403,
        message: bannedMessage(user.banned),
      });
    }

    req.user = user; // ✅ 挂到 req 上给后续路由使用
    next();
  } catch (err) {
    authDebug("Authentication failed:", err.message);
    if (err instanceof AppError) {
      return next(err);
    }

    if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
      return next(new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Invalid or expired token",
      }));
    }

    return next(new AppError({
      code: CODES.UNAUTHORIZED,
      status: 401,
      message: err?.message || "Unauthorized",
    }));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      authDebug("requireRole: No user in request");
      return next(new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Unauthorized",
      }));
    }
    if (!roles.includes(req.user.role)) {
      authDebug("requireRole: User", req.user._id, "has role", req.user.role, "but needs one of:", roles);
      return next(new AppError({
        code: CODES.FORBIDDEN,
        status: 403,
        message: "Forbidden",
      }));
    }
    next();
  };
}

async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return next(); // 没 token 就当匿名
    }

    // ★ 固定算法：不写 algorithms 时 jsonwebtoken 会按 token 头部的 alg 字段来验，
    //   这正是 alg 混淆攻击的入口（如把 HS256 换成别的对称算法试探）。我们只签 HS256。
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(payload.sub).select("_id username email role bio createdAt tokenVersion joinedGroupSlugs deactivatedAt banned");
    // 已注销 / 已封禁账号当匿名处理：不挂 req.user，也不阻塞公开接口。
    // ★ 封禁在这里降级成匿名而不是 403：optionalAuth 挂的全是「匿名本来就能看」的
    //   公开端点，403 会把公开页面也炸掉 —— 封禁挡的是「以这个身份行事」，
    //   不是「不许看公开内容」。带身份的路都在 requireAuth 后面，那边才是 403。
    if (user && !user.deactivatedAt && !isBanned(user) && Number(payload.tokenVersion || 0) === Number(user.tokenVersion || 0)) {
      req.user = user;
    }

    next();
  } catch {
    // token 坏了也当匿名，不阻塞
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
