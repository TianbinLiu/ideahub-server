// src/routes/oauth.routes.js

const router = require("express").Router();
const passport = require("passport");
const User = require("../models/User");
const { requireAuth } = require("../middleware/auth");
const AppError = require("../utils/AppError");
const CODES = require("../utils/errorCodes");
const { signToken, signOauthState, verifyOauthState } = require("../utils/jwt");

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
  return signOauthState(obj || {});
}

function decodeState(s) {
  try {
    if (!s) return {};
    return verifyOauthState(String(s));
  } catch {
    try {
      const raw = Buffer.from(String(s), "base64url").toString("utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}

function getClientBase() {
  return process.env.CLIENT_BASE_URL || "http://localhost:5173";
}

function getServerBase() {
  return process.env.SERVER_BASE_URL || "http://localhost:4000";
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

function redirectSuccess(res, token, nextPath) {
  const client = getClientBase();
  const url = new URL(`${client}/oauth/callback`);
  url.searchParams.set("token", token);
  url.searchParams.set("next", safeNextPath(nextPath));
  return res.redirect(url.toString());
}

function redirectLinkSuccess(res, provider, token, nextPath) {
  const client = getClientBase();
  const url = new URL(`${client}/oauth/callback`);
  url.searchParams.set("linked", String(provider));
  if (token) {
    url.searchParams.set("token", token);
  }
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

function getOauthConflictMessage(provider) {
  return `${provider} email is already linked to another IdeaHub login method. Please use the original sign-in method for that account.`;
}

function getOauthAlreadyLinkedMessage(provider) {
  return `${provider} is already linked to a different third-party account on this IdeaHub profile.`;
}

function countLoginMethods(user) {
  const passwordCount = user?.passwordHash ? 1 : 0;
  const googleCount = user?.providers?.google ? 1 : 0;
  const githubCount = user?.providers?.github ? 1 : 0;
  return passwordCount + googleCount + githubCount;
}

function buildOauthLinksPayload(user) {
  const linkedProviders = {
    google: Boolean(user?.providers?.google),
    github: Boolean(user?.providers?.github),
  };

  return {
    ok: true,
    availableProviders: getAvailableOauthProviders(),
    hasPassword: Boolean(user?.passwordHash),
    linkedProviders,
    canUnlink: {
      google: linkedProviders.google && countLoginMethods(user) > 1,
      github: linkedProviders.github && countLoginMethods(user) > 1,
    },
  };
}

router.get("/oauth/links", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select("providers passwordHash").lean();
    res.json(buildOauthLinksPayload(user));
  } catch (err) {
    next(err);
  }
});

router.delete("/oauth/links/:provider", requireAuth, async (req, res, next) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    if (!["google", "github"].includes(provider)) {
      throw new AppError({
        code: CODES.VALIDATION_ERROR,
        status: 400,
        message: "Invalid OAuth provider",
      });
    }

    const user = await User.findById(req.user._id).select("providers passwordHash");
    if (!user) {
      throw new AppError({
        code: CODES.UNAUTHORIZED,
        status: 401,
        message: "User not found",
      });
    }

    if (!user.providers?.[provider]) {
      throw new AppError({
        code: CODES.OAUTH_NOT_LINKED,
        status: 400,
        message: `${provider} is not linked to this account`,
      });
    }

    if (countLoginMethods(user) <= 1) {
      throw new AppError({
        code: CODES.OAUTH_UNLINK_LAST_METHOD,
        status: 400,
        message: "You must keep at least one login method on your account",
      });
    }

    user.providers[provider] = "";
    await user.save();

    res.json(buildOauthLinksPayload(user.toObject()));
  } catch (err) {
    next(err);
  }
});

router.post("/oauth/link/start", requireAuth, async (req, res, next) => {
  try {
    const provider = String(req.body?.provider || "").toLowerCase();
    const nextPath = safeNextPath(req.body?.next || "/me");
    const availableProviders = getAvailableOauthProviders();

    if (!availableProviders.includes(provider)) {
      res.status(400);
      throw new Error("OAuth provider is not available");
    }

    const state = encodeState({
      mode: "link",
      provider,
      next: nextPath,
      linkUserId: req.user._id.toString(),
    });

    const redirectUrl = new URL(`${getServerBase()}/api/auth/oauth/${provider}/link`);
    redirectUrl.searchParams.set("state", state);

    res.json({ ok: true, redirectUrl: redirectUrl.toString() });
  } catch (err) {
    next(err);
  }
});

router.get("/oauth/google/link", (req, res, next) => {
  const state = String(req.query.state || "");
  passport.authenticate("google", {
    session: false,
    scope: ["profile", "email"],
    prompt: "select_account",
    state,
  })(req, res, next);
});

router.get("/oauth/github/link", (req, res, next) => {
  const state = String(req.query.state || "");
  passport.authenticate("github", { session: false, state })(req, res, next);
});

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

      if (st.mode === "link") {
        const linkUserId = String(st.linkUserId || "");
        if (!linkUserId) {
          return redirectFail(res, "oauth_failed", "Missing link user", nextPath);
        }

        const linkUser = await User.findById(linkUserId);
        if (!linkUser) {
          return redirectFail(res, "oauth_failed", "Link target user not found", nextPath);
        }

        const providerOwner = await User.findOne({ "providers.google": googleId });
        if (providerOwner && providerOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
        }

        const emailOwner = await User.findOne({ email });
        if (emailOwner && emailOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
        }

        if (linkUser.providers.google && linkUser.providers.google !== googleId) {
          return redirectFail(res, "oauth_conflict", getOauthAlreadyLinkedMessage("Google"), nextPath);
        }

        linkUser.providers.google = googleId;
        if (!linkUser.avatarUrl && avatarUrl) linkUser.avatarUrl = avatarUrl;
        linkUser.emailVerified = true;
        await linkUser.save();

        return redirectLinkSuccess(res, "google", signToken(linkUser), nextPath);
      }

      let user = await User.findOne({ "providers.google": googleId });

      if (!user) {
        const existingUserWithEmail = await User.findOne({ email });
        if (existingUserWithEmail) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("Google"), nextPath);
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

      if (st.mode === "link") {
        const linkUserId = String(st.linkUserId || "");
        if (!linkUserId) {
          return redirectFail(res, "oauth_failed", "Missing link user", nextPath);
        }

        const linkUser = await User.findById(linkUserId);
        if (!linkUser) {
          return redirectFail(res, "oauth_failed", "Link target user not found", nextPath);
        }

        const providerOwner = await User.findOne({ "providers.github": githubId });
        if (providerOwner && providerOwner._id.toString() !== linkUserId) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
        }

        if (email) {
          const emailOwner = await User.findOne({ email });
          if (emailOwner && emailOwner._id.toString() !== linkUserId) {
            return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
          }
        }

        if (linkUser.providers.github && linkUser.providers.github !== githubId) {
          return redirectFail(res, "oauth_conflict", getOauthAlreadyLinkedMessage("GitHub"), nextPath);
        }

        linkUser.providers.github = githubId;
        if (!linkUser.avatarUrl && avatarUrl) linkUser.avatarUrl = avatarUrl;
        if (email) linkUser.emailVerified = true;
        await linkUser.save();

        return redirectLinkSuccess(res, "github", signToken(linkUser), nextPath);
      }

      let user = await User.findOne({ "providers.github": githubId });

      if (!user && email) {
        const existingUserWithEmail = await User.findOne({ email });
        if (existingUserWithEmail) {
          return redirectFail(res, "oauth_conflict", getOauthConflictMessage("GitHub"), nextPath);
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
