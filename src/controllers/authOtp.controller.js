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

module.exports = { emailRegisterStart, emailRegisterVerify };
