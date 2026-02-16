const AppError = require("./AppError");
const CODES = require("./errorCodes");

function badRequest(message = "Bad request", details) {
  throw new AppError({ code: CODES.VALIDATION_ERROR, status: 400, message, details });
}
function otpCooldown(message = "Please wait before requesting another code", retryAfterSeconds = 60) {
  throw new AppError({ code: CODES.OTP_RESEND_COOLDOWN, status: 429, message, details: { retryAfter: retryAfterSeconds } });
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

module.exports = { badRequest, unauthorized, forbidden, notFound, invalidId };
