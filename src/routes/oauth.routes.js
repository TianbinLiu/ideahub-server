// src/routes/oauth.routes.js

const router = require("express").Router();
const passport = require("passport");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");

function safeUsername(base) {
  return String(base || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20) || "user";
}

async function makeUniqueUsername(base) {
  const stem = safeUsername(base);
  let candidate = stem;
  let i = 0;
  while (await User.findOne({ username: candidate })) {
    i += 1;
    candidate = `${stem}${i}`;
    if (candidate.length > 24) candidate = `${stem.slice(0, 18)}${i}`;
  }
  return candidate;
}

// ---- next / state helpers ----
function safeNextPath(next) {
  if (!next) return "/";
  const s = String(next);
  if (!s.startsWith("/")) return "/";
  if (s.startsWith("//")) return "/";
  return s;
}

function encodeState(obj) {
  return Buffer.from(JSON.stringify(obj || {}), "utf8").toString("base64url");
}

function decodeState(s) {
  try {
    if (!s) return {};
    const raw = Buffer.from(String(s), "base64url").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getClientBase() {
  return process.env.CLIENT_BASE_URL || "http://localhost:5173";
}

function redirectSuccess(res, token, nextPath) {
  const client = getClientBase();
  const url = new URL(`${client}/oauth/callback`);
  url.searchParams.set("token", token);
  url.searchParams.set("next", safeNextPath(nextPath));
  return res.redirect(url.toString());
}

function redirectFail(res, error, message, nextPath) {
  const client = getClientBase();
  const url = new URL(`${client}/oauth/callback`);
  url.searchParams.set("error", String(error || "oauth_failed"));
  if (message) url.searchParams.set("message", String(message));
  url.searchParams.set("next", safeNextPath(nextPath));
  return res.redirect(url.toString());
}

// ---------------- Google ----------------
router.get("/oauth/google", (req, res, next) => {
  const nextPath = safeNextPath(req.query.next);
  const state = encodeState({ next: nextPath, provider: "google" });

  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
    prompt: "select_account",
    state,
  })(req, res, next);
});

router.get(
  "/oauth/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: "/api/auth/oauth/fail?provider=google" }),
  async (req, res) => {
    const st = decodeState(req.query.state);
    const nextPath = safeNextPath(st.next);

    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing google profile", nextPath);

      const googleId = profile.id;
      const emails = profile.emails || [];
      const email = (emails[0]?.value || "").toLowerCase();
      const avatarUrl = profile.photos?.[0]?.value || "";

      if (!email) return redirectFail(res, "oauth_failed", "Google email not available", nextPath);

      let user = await User.findOne({ "providers.google": googleId });

      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          user.providers.google = googleId;
          if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
          user.emailVerified = true;
          await user.save();
        }
      }

      if (!user) {
        const usernameBase = profile.displayName || email.split("@")[0];
        const username = await makeUniqueUsername(usernameBase);

        user = await User.create({
          username,
          email,
          passwordHash: "",
          role: "user",
          bio: "",
          providers: { google: googleId, github: "" },
          avatarUrl,
          emailVerified: true,
        });
      }

      const token = signToken(user);
      return redirectSuccess(res, token, nextPath);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "Google callback error", nextPath);
    }
  }
);

// ---------------- GitHub ----------------
router.get("/oauth/github", (req, res, next) => {
  const nextPath = safeNextPath(req.query.next);
  const state = encodeState({ next: nextPath, provider: "github" });

  passport.authenticate("github", { session: false, state })(req, res, next);
});

router.get(
  "/oauth/github/callback",
  passport.authenticate("github", { session: false, failureRedirect: "/api/auth/oauth/fail?provider=github" }),
  async (req, res) => {
    const st = decodeState(req.query.state);
    const nextPath = safeNextPath(st.next);

    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing github profile", nextPath);

      const githubId = profile.id;
      const avatarUrl = profile.photos?.[0]?.value || "";
      const email = (profile.emails?.[0]?.value || "").toLowerCase();

      let user = await User.findOne({ "providers.github": githubId });

      if (!user && email) {
        user = await User.findOne({ email });
        if (user) {
          user.providers.github = githubId;
          if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
          if (email) user.emailVerified = true;
          await user.save();
        }
      }

      if (!user) {
        const finalEmail = email || `github_${githubId}@no-email.ideahub.local`;
        const usernameBase = profile.username || profile.displayName || `github${githubId}`;
        const username = await makeUniqueUsername(usernameBase);

        user = await User.create({
          username,
          email: finalEmail,
          passwordHash: "",
          role: "user",
          bio: "",
          providers: { google: "", github: githubId },
          avatarUrl,
          emailVerified: !!email,
        });
      }

      const token = signToken(user);
      return redirectSuccess(res, token, nextPath);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "GitHub callback error", nextPath);
    }
  }
);

router.get("/oauth/fail", (req, res) => {
  const provider = req.query.provider || "oauth";
  // 从 fail 过来拿不到 state，所以 next 就给 "/"
  return redirectFail(res, "oauth_failed", `${provider} login failed`, "/");
});

module.exports = router;
