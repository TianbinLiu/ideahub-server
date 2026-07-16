const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

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

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.sub;

    const user = await User.findById(userId).select("_id username email role bio createdAt tokenVersion joinedGroupSlugs deactivatedAt");
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

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub).select("_id username email role bio createdAt tokenVersion joinedGroupSlugs deactivatedAt");
    // 已注销账号当匿名处理：不挂 req.user，也不阻塞公开接口
    if (user && !user.deactivatedAt && Number(payload.tokenVersion || 0) === Number(user.tokenVersion || 0)) {
      req.user = user;
    }

    next();
  } catch {
    // token 坏了也当匿名，不阻塞
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
