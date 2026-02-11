const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      res.status(401);
      throw new Error("Missing or invalid Authorization header");
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload.sub;

    const user = await User.findById(userId).select("_id username email role bio createdAt");
    if (!user) {
      res.status(401);
      throw new Error("User not found");
    }

    req.user = user; // ✅ 挂到 req 上给后续路由使用
    next();
  } catch (err) {
    res.status(401);
    next(new Error("Unauthorized: " + err.message));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401);
      return next(new Error("Unauthorized"));
    }
    if (!roles.includes(req.user.role)) {
      res.status(403);
      return next(new Error("Forbidden"));
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
    const user = await User.findById(payload.sub).select("_id username email role bio createdAt");
    if (user) req.user = user;

    next();
  } catch {
    // token 坏了也当匿名，不阻塞
    next();
  }
}

module.exports = { requireAuth, requireRole, optionalAuth };
