//auth.controller.js

const bcrypt = require("bcryptjs");
const geoip = require("geoip-lite");
const { isRealSmsConfigured } = require("../services/sms.service");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { signToken } = require("../utils/jwt");
const { normalizeNewUsername, CI_COLLATION } = require("../utils/username");
const { grantSignupBonus } = require("../services/points.service");

function serializeAuthUser(user) {
  return {
    _id: user._id,
    username: user.username,
    uid: user.uid ?? null,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl || "",
    hasPassword: Boolean(user.passwordHash),
    // 同意到哪一版用户协议（空串 = 没同意过）。App 端登录/冷启动拿它对账：
    // 服务端已有当前版本就不再弹补签门（POST /api/me/accept-terms 是写入口）
    termsAcceptedVersion: user.termsAcceptedVersion || "",
  };
}

function parseBooleanEnv(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

// 国家码 → region：CN→CN，其它非空→GLOBAL，空/占位(XX/T1)→UNKNOWN。
function regionFromCountry(rawCountry) {
  const country = String(rawCountry || "").trim().toUpperCase();
  if (!country || country === "XX" || country === "T1") {
    return { country: "", region: "UNKNOWN" };
  }
  if (country === "CN") return { country, region: "CN" };
  return { country, region: "GLOBAL" };
}

// 判定请求方所在地区（用于登录界面按地区切换：CN→微信/QQ 套，其它→Google/GitHub 套）。
//
// 两级来源，可信度从高到低：
// 1) 可信边缘/CDN 注入的国家头（Cloudflare cf-ipcountry / Vercel / GAE）—— 经可信代理设置，最权威；
//    生产在阿里云直连、暂无这类头时它们都为空，落到第 2 步。
// 2) geoip-lite 按【客户端 IP】自查国家 —— app.js 已 trust proxy=1，故 req.ip 是 nginx
//    X-Forwarded-For 里的真实客户端 IP。私网/本地/库中查不到的 IP → UNKNOWN。
//
// ⚠️ 该判定只驱动【展示哪套登录按钮】这类 UX，不是安全边界（两套 UI 最终走的是同一批鉴权后端，
// 微信/QQ 目前还是占位）。故不必对 IP 伪造做强校验；真要做地区合规限制须在可信边缘层校验。
function detectRegion(req) {
  const countryHeader =
    req.headers["cf-ipcountry"] ||
    req.headers["x-vercel-ip-country"] ||
    req.headers["x-country-code"] ||
    req.headers["x-appengine-country"];
  const headerCountry = String(countryHeader || "").trim().toUpperCase();
  if (headerCountry && headerCountry !== "XX" && headerCountry !== "T1") {
    return regionFromCountry(headerCountry);
  }

  try {
    // 去掉 IPv4-mapped IPv6 前缀（::ffff:1.2.3.4 → 1.2.3.4），否则 geoip 查不到。
    const ip = String(req.ip || "").trim().replace(/^::ffff:/i, "");
    const geo = ip ? geoip.lookup(ip) : null;
    if (geo && geo.country) return regionFromCountry(geo.country);
  } catch {
    // geoip 查询异常绝不能影响登录能力探测，静默回退 UNKNOWN。
  }
  return { country: "", region: "UNKNOWN" };
}

function getAvailableOauthProviders() {
  const providers = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.push("github");
  }
  return providers;
}

async function register(req, res, next) {
  try {
    const { username: rawUsername, email, password, role } = req.body;

    if (!rawUsername || !email || !password) {
      res.status(400);
      throw new Error("username, email, password are required");
    }
    if (password.length < 6) {
      res.status(400);
      throw new Error("password must be at least 6 characters");
    }
    // ★ 长度上限在这里挡住，理由与"存量超长用户名怎么办"一起写在 utils/username.js：
    //   不挡的话，注册出来的账号在两条产品线上都**永远 @ 不到**（令牌只切前 32 个字符），
    //   而且表现是"打了 @ 没反应"，一个错都不报。
    const username = normalizeNewUsername(rawUsername);

    // ★★ 查重必须带 CI_COLLATION：username 是本 app 公开的 @ 句柄，不带 collation 的话
    //   "tianbinliu" 已存在时还能注册出 "TianbinLiu" —— 两个账号在界面上肉眼几乎分不出，
    //   而 @ 的补全面板会把它们并排列出来，这就是最省事的冒名手法。
    //   ⚠ collation 是**整条查询**的属性，不能只作用于 $or 的某一个分支，所以 email 也一并
    //   变成大小写不敏感 —— 这对 email 恰好是**想要**的（邮箱本地部分理论上区分大小写，
    //   但没有任何真实邮箱服务商这么用，而 "A@x.com" 与 "a@x.com" 注册成两个账号只会制造
    //   找回密码时的悬案）。email 的唯一索引仍是区分大小写的那条，所以这里只是**更严**，
    //   不会放过任何原本会被挡下的重复。
    //   兜底仍在 DB：models/User.js 的 username_ci 索引现在是 unique，
    //   并发注册撞车时由它抛 E11000（下面的 catch 会转成 409）。
    const exists = await User.findOne({ $or: [{ username }, { email }] }).collation(CI_COLLATION);
    if (exists) {
      res.status(409);
      throw new Error("username or email already in use");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      passwordHash,
      role: role === "company" ? "company" : "user", // Phase 2 先允许 user/company
      bio: "",
    });

    // 注册赠送虚拟点数（唯一的印钱口）。余额本身来自 User schema 的 default，
    // 这里只是把它记进账本；幂等，同一个 user 不会有第二条 signup 分录。
    await grantSignupBonus(user._id);

    const token = signToken(user);

    res.status(201).json({
      ok: true,
      token,
      user: serializeAuthUser(user),
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "emailOrUsername and password are required",
      });
    }

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { username: emailOrUsername }],
    });

    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Invalid credentials",
      });
    }

    const ok = await bcrypt.compare(password, user.passwordHash || "");
    if (!ok) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "Invalid credentials",
      });
    }

    const token = signToken(user);

    res.json({
      ok: true,
      token,
      user: serializeAuthUser(user),
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select("_id username email role avatarUrl passwordHash termsAcceptedVersion");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    res.json({ ok: true, user: serializeAuthUser(user) });
  } catch (err) {
    next(err);
  }
}

async function setPassword(req, res, next) {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Password must be at least 6 characters",
      });
    }

    const user = await User.findById(req.user._id).select("_id username email role avatarUrl passwordHash termsAcceptedVersion");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    if (user.passwordHash) {
      throw new AppError({
        code: CODES.PASSWORD_ALREADY_SET,
        status: 400,
        message: "Password login is already enabled for this account",
      });
    }

    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    const token = signToken(user);
    res.json({ ok: true, token, user: serializeAuthUser(user) });
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Current password and new password are required",
      });
    }

    if (String(newPassword).length < 6) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Password must be at least 6 characters",
      });
    }

    const user = await User.findById(req.user._id).select("_id username email role avatarUrl passwordHash termsAcceptedVersion");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    if (!user.passwordHash) {
      throw new AppError({
        code: CODES.PASSWORD_NOT_SET,
        status: 400,
        message: "Password login is not enabled for this account",
      });
    }

    const ok = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!ok) {
      throw new AppError({
        code: CODES.INVALID_CURRENT_PASSWORD,
        status: 400,
        message: "Current password is incorrect",
      });
    }

    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    const token = signToken(user);
    res.json({ ok: true, token, user: serializeAuthUser(user) });
  } catch (err) {
    next(err);
  }
}

async function logoutAllSessions(req, res, next) {
  try {
    const user = await User.findById(req.user._id).select("_id tokenVersion");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

function getAuthCapabilities(req, res) {
  const providers = getAvailableOauthProviders();
  const forceOauth = parseBooleanEnv(process.env.AUTH_FORCE_OAUTH);
  const forceOauthInCn = parseBooleanEnv(process.env.AUTH_FORCE_OAUTH_IN_CN);
  const { country, region } = detectRegion(req);

  let oauthEnabledByRegion = region !== "CN";
  if (region === "CN" && forceOauthInCn !== null) {
    oauthEnabledByRegion = forceOauthInCn;
  }

  const oauthEnabled =
    forceOauth !== null
      ? forceOauth
      : oauthEnabledByRegion;

  // 手机短信登录是否可用：仅当【真实短信通道已配置】(aliyun-pnvs + AK/SK + 签名/模板)。
  // 不依赖 NODE_ENV —— 生产若没设 NODE_ENV，也绝不会因 dev provider 而误显示一个发不出码的死按钮。
  // 本地联调想预览手机 UI 用前端 ?phone=1 覆盖，不走这里。
  const phoneEnabled = isRealSmsConfigured();

  res.json({
    ok: true,
    region,
    country,
    emailPasswordEnabled: true,
    oauthEnabled: oauthEnabled && providers.length > 0,
    phoneEnabled,
    providers,
    fallback: {
      forceOauth,
      forceOauthInCn,
    },
  });
}


module.exports = { register, login, me, setPassword, changePassword, logoutAllSessions, getAuthCapabilities };
