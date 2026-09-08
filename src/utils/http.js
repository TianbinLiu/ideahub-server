const AppError = require("./AppError");
const CODES = require("./errorCodes");

function badRequest(message = "Bad request", details) {
  throw new AppError({ code: CODES.VALIDATION_ERROR, status: 400, message, details });
}
function otpCooldown(message = "Please wait before requesting another code", retryAfterSeconds = 60) {
  throw new AppError({ code: CODES.OTP_RESEND_COOLDOWN, status: 429, message, details: { retryAfter: retryAfterSeconds } });
}
function commentCooldown(message = "Please wait before commenting again", retryAfterSeconds = 10) {
  throw new AppError({ code: CODES.COMMENT_COOLDOWN, status: 429, message, details: { retryAfter: retryAfterSeconds } });
}
function publicLimitExceeded(message = "Public idea limit reached", limit = 5) {
  throw new AppError({ code: CODES.PUBLIC_LIMIT_EXCEEDED, status: 403, message, details: { limit } });
}
function unauthorized(message = "Unauthorized") {
  throw new AppError({ code: CODES.UNAUTHORIZED, status: 401, message });
}
function forbidden(message = "Forbidden") {
  throw new AppError({ code: CODES.FORBIDDEN, status: 403, message });
}
function notFound(message = "Not found") {
  throw new AppError({ code: CODES.NOT_FOUND, status: 404, message });
}
function invalidId(message = "Invalid id") {
  throw new AppError({ code: CODES.INVALID_ID, status: 400, message });
}

/**
 * 带**自定义 code + 自定义整句人话**的 4xx —— 上面那几个函数的 code 是 `errorCodes` 里
 * 的固定枚举，而有些业务拒绝（回炉的 REVISE_*、工程留存的 PROJECT_*）要把 code 和
 * 那句中文一起交给客户端**原样显示给用户**（铁律八），枚举装不下。
 *
 * ★ 2026-09-07 合并：branchVideo.controller 与 branchProject.controller 里各有一份
 *   逐字相同的实现（同一次提交里写出来的），合成这一处（铁律六）。
 */
function failWith(status, code, message, details) {
  throw new AppError({ status, code, message, details });
}

module.exports = { badRequest, otpCooldown, commentCooldown, publicLimitExceeded, unauthorized, forbidden, notFound, invalidId, failWith };
