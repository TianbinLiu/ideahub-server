//auth.controller.js

const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");

function parseBooleanEnv(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

function detectRegion(req) {
  const countryHeader =
    req.headers["cf-ipcountry"] ||
    req.headers["x-vercel-ip-country"] ||
    req.headers["x-country-code"] ||
    req.headers["x-appengine-country"];

  const country = String(countryHeader || "").trim().toUpperCase();
  if (!country || country === "XX" || country === "T1") {
    return { country: "", region: "UNKNOWN" };
  }

  if (country === "CN") {
    return { country, region: "CN" };
  }

  return { country, region: "GLOBAL" };
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
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
      res.status(400);
      throw new Error("username, email, password are required");
    }
    if (password.length < 6) {
      res.status(400);
      throw new Error("password must be at least 6 characters");
    }

    const exists = await User.findOne({ $or: [{ username }, { email }] });
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

async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      res.status(400);
      throw new Error("emailOrUsername and password are required");
    }

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { username: emailOrUsername }],
    });

    if (!user) {
      res.status(401);
      throw new Error("Invalid credentials");
    }

    const ok = await bcrypt.compare(password, user.passwordHash || "");
    if (!ok) {
      res.status(401);
      throw new Error("Invalid credentials");
    }

    const token = signToken(user);

    res.json({
      ok: true,
      token,
      user: { id: user._id, username: user.username, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res) {
  res.json({ ok: true, user: req.user });
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

  res.json({
    ok: true,
    region,
    country,
    emailPasswordEnabled: true,
    oauthEnabled: oauthEnabled && providers.length > 0,
    providers,
    fallback: {
      forceOauth,
      forceOauthInCn,
    },
  });
}


module.exports = { register, login, me, getAuthCapabilities };
