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
  let status = err.status || 500;
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

  res.status(status).json({
    ok: false,
    code,
    message: process.env.NODE_ENV === "production" && status === 500 ? "Server error" : message,
    ...(details ? { details } : {}),
  });
}

module.exports = { notFound, errorHandler };
