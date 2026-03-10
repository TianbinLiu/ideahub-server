const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      console.log('[Auth] Missing or invalid Authorization header');
      res.status(401);
      throw new Error("Missing or invalid Authorization header");
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.sub;

    const user = await User.findById(userId).select("_id username email role bio createdAt");
    if (!user) {
      console.log('[Auth] User not found:', userId);
      res.status(401);
      throw new Error("User not found");
    }

    console.log('[Auth] User authenticated:', user._id, 'role:', user.role);
    req.user = user; // ✅ 挂到 req 上给后续路由使用
    next();
  } catch (err) {
    console.log('[Auth] Authentication failed:', err.message);
    res.status(401);
    next(new Error("Unauthorized: " + err.message));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      console.log('[Auth] requireRole: No user in request');
      res.status(401);
      return next(new Error("Unauthorized"));
    }
    if (!roles.includes(req.user.role)) {
      console.log('[Auth] requireRole: User', req.user._id, 'has role', req.user.role, 'but needs one of:', roles);
      res.status(403);
      return next(new Error("Forbidden"));
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
    const user = await User.findById(payload.sub).select("_id username email role bio createdAt");
    if (user) req.user = user;

    next();
  } catch {
    // token 坏了也当匿名，不阻塞
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
