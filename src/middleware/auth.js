const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      console.log('[Auth] Missing or invalid Authorization header');
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Missing or invalid Authorization header",
      });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.sub;

    const user = await User.findById(userId).select("_id username email role bio createdAt tokenVersion");
    if (!user) {
      console.log('[Auth] User not found:', userId);
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Session expired. Please log in again.",
      });
    }

    console.log('[Auth] User authenticated:', user._id, 'role:', user.role);
    req.user = user; // ✅ 挂到 req 上给后续路由使用
    next();
  } catch (err) {
    console.log('[Auth] Authentication failed:', err.message);
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
      console.log('[Auth] requireRole: No user in request');
      return next(new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Unauthorized",
      }));
    }
    if (!roles.includes(req.user.role)) {
      console.log('[Auth] requireRole: User', req.user._id, 'has role', req.user.role, 'but needs one of:', roles);
      return next(new AppError({
        code: CODES.FORBIDDEN,
        status: 403,
        message: "Forbidden",
      }));
    }
    console.log('[Auth] requireRole: User', req.user._id, 'has required role:', req.user.role);
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
    const user = await User.findById(payload.sub).select("_id username email role bio createdAt tokenVersion");
    if (user && Number(payload.tokenVersion || 0) === Number(user.tokenVersion || 0)) {
      req.user = user;
    }

    next();
  } catch {
    // token 坏了也当匿名，不阻塞
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
