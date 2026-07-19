//authOtp.controller.js

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { badRequest } = require("../utils/http");
const { normEmail, createOtp, verifyOtp } = require("../services/otp.service");
const { sendEmailOtp } = require("../services/email.service");
const { sendPhoneOtp, checkPhoneOtp } = require("../services/sms.service");
const { grantSignupBonus } = require("../services/points.service");

// 归一手机号：去空格/连字符，去掉 +86 / 86 前缀，只留 11 位。
function normPhone(p) {
  return String(p || "").replace(/[\s-]/g, "").replace(/^\+?86/, "");
}
function isCnMobile(p) {
  return /^1[3-9]\d{9}$/.test(p);
}
// 手机注册用户的用户名：不从手机号派生（用户名是公开的，派生会泄露号码），随机生成并去重。
async function makeUniquePhoneUsername() {
  for (let i = 0; i < 20; i++) {
    const candidate = `user_${crypto.randomBytes(4).toString("hex")}`;
    const exists = await User.findOne({ username: candidate }).lean();
    if (!exists) return candidate;
  }
  return `user_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

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

    // 注册赠送虚拟点数（唯一的印钱口）。只接在【新建用户】这一支上：
    // register/start 不建用户，reset/verify 是既有用户改密码，都不能赠送。
    await grantSignupBonus(user._id);

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

// ── 手机号 + 短信验证码登录（登录即注册，同一入口）──────────────────────

// POST /api/auth/phone/login/start —— 发验证码
async function phoneLoginStart(req, res, next) {
  try {
    const phone = normPhone(req.body.phone);
    if (!isCnMobile(phone)) badRequest("请输入有效的中国大陆手机号");

    // 未配短信通道时 sendPhoneOtp 会 badRequest("短信服务未配置")，前端据此提示/回退。
    await sendPhoneOtp({ phone, purpose: "phone_login" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/phone/login/verify —— 校验验证码；该号没注册过则【自动建号并登录】
async function phoneLoginVerify(req, res, next) {
  try {
    const phone = normPhone(req.body.phone);
    const code = String(req.body.code || "").trim();
    if (!isCnMobile(phone)) badRequest("请输入有效的中国大陆手机号");
    if (!code) badRequest("请输入验证码");

    await checkPhoneOtp({ phone, purpose: "phone_login", code }); // 失败会 throw badRequest

    let user = await User.findOne({ phone });
    let created = false;
    if (!user) {
      try {
        const username = await makeUniquePhoneUsername();
        user = await User.create({
          username,
          // 手机用户没有真实邮箱 —— 走合成邮箱（与 OAuth 无邮箱 provider 同一套），
          // 满足 email required+unique；用户日后可在设置里补真实邮箱。
          email: `phone_${phone}@no-email.ideahub.local`,
          passwordHash: "",
          phone,
          phoneVerified: true,
          role: "user",
          bio: "",
        });
        created = true;
      } catch (e) {
        // 并发：另一请求已用同一手机号建号（命中 phone 唯一索引）——改取那条，不重复赠点。
        if (e && e.code === 11000) {
          user = await User.findOne({ phone });
          if (!user) throw e;
        } else {
          throw e;
        }
      }
      // 印钱口（赠点）只接在【新建用户】这一支上，与邮箱注册一致。
      if (created) await grantSignupBonus(user._id);
    } else if (!user.phoneVerified) {
      user.phoneVerified = true;
      await user.save();
    }

    const token = signToken(user);
    res.status(created ? 201 : 200).json({
      ok: true,
      token,
      created,
      user: { id: user._id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  emailRegisterStart,
  emailRegisterVerify,
  emailResetStart,
  emailResetVerify,
  phoneLoginStart,
  phoneLoginVerify,
};
