//authOtp.controller.js

const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { badRequest } = require("../utils/http");
const { normEmail, createOtp, verifyOtp } = require("../services/otp.service");
const { sendEmailOtp } = require("../services/email.service");

// POST /api/auth/email/register/start
async function emailRegisterStart(req, res, next) {
  try {
    const { email, username, password } = req.body;
    const e = normEmail(email);

    if (!e || !username || !password) badRequest("email, username, password are required");
    if (String(password).length < 6) badRequest("password must be at least 6 characters");

    const exists = await User.findOne({ $or: [{ email: e }, { username }] }).lean();
    if (exists) badRequest("username or email already in use");

    // 发 OTP
    const { code } = await createOtp({ target: e, purpose: "email_register" });
    await sendEmailOtp({ to: e, code });

    // 注意：这里不创建用户，只返回 ok
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/email/register/verify
async function emailRegisterVerify(req, res, next) {
  try {
    const { email, username, password, code, role } = req.body;
    const e = normEmail(email);

    if (!e || !username || !password || !code) badRequest("email, username, password, code are required");

    await verifyOtp({ target: e, purpose: "email_register", code });

    const exists = await User.findOne({ $or: [{ email: e }, { username }] }).lean();
    if (exists) badRequest("username or email already in use");

    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = await User.create({
      username,
      email: e,
      passwordHash,
      emailVerified: true,
      role: role === "company" ? "company" : "user",
      bio: "",
    });

    const token = signToken(user);
    res.status(201).json({
      ok: true,
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/email/reset/start
async function emailResetStart(req, res, next) {
  try {
    const { email } = req.body;
    const e = normEmail(email);

    if (!e) badRequest("email is required");

    // 不泄露用户是否存在：如果用户存在则发送 OTP；否则仍返回 ok
    const user = await User.findOne({ email: e }).lean();
    if (user) {
      const { code } = await createOtp({ target: e, purpose: "email_reset" });
      await sendEmailOtp({ to: e, code });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/email/reset/verify
async function emailResetVerify(req, res, next) {
  try {
    const { email, code, newPassword } = req.body;
    const e = normEmail(email);

    if (!e || !code || !newPassword) badRequest("email, code and newPassword are required");
    if (String(newPassword).length < 6) badRequest("password must be at least 6 characters");

    await verifyOtp({ target: e, purpose: "email_reset", code });

    const user = await User.findOne({ email: e });
    if (!user) {
      // 不应出现：验证成功但用户不存在
      badRequest("User not found");
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    user.passwordHash = passwordHash;
    await user.save();

    const token = signToken(user);
    res.json({ ok: true, token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
}

module.exports = { emailRegisterStart, emailRegisterVerify, emailResetStart, emailResetVerify };
