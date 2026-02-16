//otp.service.js

const crypto = require("crypto");
const OtpToken = require("../models/OtpToken");
const { badRequest, otpCooldown } = require("../utils/http");

function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function genCode6() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, "0");
}

function hashCode(code) {
  const pepper = process.env.OTP_PEPPER || "dev_pepper_change_me";
  return crypto.createHash("sha256").update(`${code}:${pepper}`).digest("hex");
}

function minutesFromNow(m) {
  return new Date(Date.now() + m * 60 * 1000);
}

async function canResend(latest) {
  const cd = parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || "60", 10);
  if (!latest?.lastSentAt) return true;
  return Date.now() - new Date(latest.lastSentAt).getTime() >= cd * 1000;
}

async function createOtp({ target, purpose }) {
  const ttl = parseInt(process.env.OTP_TTL_MINUTES || "10", 10);

  // 读取最新一条，做 resend 冷却（避免刷接口）
  const latest = await OtpToken.findOne({ target, purpose }).sort({ createdAt: -1 }).lean();
  if (latest && latest.usedAt == null && latest.expiresAt && new Date(latest.expiresAt) > new Date()) {
    const ok = await canResend(latest);
    if (!ok) badRequest("Please wait before requesting another code");
  }
  // If not ok, provide retryAfter seconds to client via otpCooldown
  if (latest && latest.usedAt == null && latest.expiresAt && new Date(latest.expiresAt) > new Date()) {
    const cd = parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || "60", 10);
    const since = Date.now() - new Date(latest.lastSentAt).getTime();
    const retryAfter = Math.max(0, cd - Math.floor(since / 1000));
    const ok = await canResend(latest);
    if (!ok) otpCooldown("Please wait before requesting another code", retryAfter);
  }
  const code = genCode6();
  const token = await OtpToken.create({
    target,
    purpose,
    codeHash: hashCode(code),
    attempts: 0,
    usedAt: null,
    expiresAt: minutesFromNow(ttl),
    lastSentAt: new Date(),
  });

  return { code, tokenId: token._id };
}

async function verifyOtp({ target, purpose, code }) {
  const maxAttempts = parseInt(process.env.OTP_MAX_ATTEMPTS || "5", 10);
  const now = new Date();

  const doc = await OtpToken.findOne({ target, purpose }).sort({ createdAt: -1 });
  if (!doc) badRequest("Invalid or expired code");
  if (doc.usedAt) badRequest("Code already used");
  if (doc.expiresAt <= now) badRequest("Code expired");

  doc.attempts = (doc.attempts || 0) + 1;
  if (doc.attempts > maxAttempts) {
    doc.usedAt = now;
    await doc.save();
    badRequest("Too many attempts. Please request a new code.");
  }

  const ok = doc.codeHash === hashCode(String(code || ""));
  if (!ok) {
    await doc.save();
    badRequest("Invalid code");
  }

  doc.usedAt = now;
  await doc.save();
  return { ok: true };
}

module.exports = { normEmail, createOtp, verifyOtp };
