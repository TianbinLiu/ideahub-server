//error.js

const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");

function notFound(req, res, next) {
  next(
    new AppError({
      code: CODES.NOT_FOUND,
      status: 404,
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    })
  );
}

function errorHandler(err, req, res, next) {
  // 仓里有两套写法：AppError 把状态码带在 err.status 上，而 auth/ideas/interest 等
  // controller 用的是 Express 惯例的 `res.status(400); throw new Error(...)`。
  // 后者的普通 Error 没有 .status，只认 err.status 的话这 15 处全部退化成 500
  // （表现：注册撞用户名返回的是"服务器错误"而不是 409）。两套都认。
  const preset = res.statusCode >= 400 ? res.statusCode : 0;
  let status = err.status || preset || 500;
  let code = err.code || CODES.SERVER_ERROR;
  let message = err.message || "Server error";
  let details = err.details;

  // Zod
  if (err.name === "ZodError") {
    status = 400;
    code = CODES.VALIDATION_ERROR;
    // zod 4 把问题列表放在 issues（v3 的 errors 已经没有了，此前 details 一直是 undefined）。
    // superRefine / transform 里 addIssue 的 custom 是我们自己写的人话（「只能混 1.0 音色」「world is reserved」），
    // 直接当 message 回给前端；zod 自带的英文（"Too big: …"）留在 details 里
    const issues = Array.isArray(err.issues) ? err.issues : Array.isArray(err.errors) ? err.errors : [];
    const custom = issues.find((i) => i && i.code === "custom" && i.message);
    message = custom ? custom.message : "Validation error";
    details = issues;
  }

  // Mongo duplicate key
  if (err.code === 11000) {
    status = 409;
    code = CODES.DUPLICATE;
    message = "Duplicate key";
    details = err.keyValue;
  }

  // CastError (ObjectId)
  if (err.name === "CastError") {
    status = 400;
    code = CODES.INVALID_ID;
    message = "Invalid id";
  }

  if (err.code === "LIMIT_FILE_SIZE") {
    status = 400;
    code = CODES.VALIDATION_ERROR;
    message = "Uploaded file is too large";
  }

  // ★★ 500 必须落堆栈（2026-09-05 主人真机：发布「仅链接可看」的作品回「Server error」，
  //   而 pm2 两份日志里**一个字都没有** —— 生产把 message 压成 Server error 是对的（不泄露
  //   内部），但压掉之前不记下来，就是把唯一的线索一起压没了。本机用同形状草稿复现不出来，
  //   只能等它再发生一次；没有这一行，再发生一百次也还是一句 Server error。
  //   4xx 是用户可纠正的错，本来就整句回给了客户端，不在这里刷屏。
  if (status >= 500) {
    console.error(
      `[http] ${status} ${req.method} ${req.originalUrl} user=${req.user ? String(req.user._id) : "-"}:`,
      err && err.stack ? err.stack : err,
    );
  }

  res.status(status).json({
    ok: false,
    code,
    message: process.env.NODE_ENV === "production" && status === 500 ? "Server error" : message,
    ...(details ? { details } : {}),
  });
}

module.exports = { notFound, errorHandler };
