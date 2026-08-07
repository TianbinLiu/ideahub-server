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
    message = "Validation error";
    details = err.errors;
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

  res.status(status).json({
    ok: false,
    code,
    message: process.env.NODE_ENV === "production" && status === 500 ? "Server error" : message,
    ...(details ? { details } : {}),
  });
}

module.exports = { notFound, errorHandler };
