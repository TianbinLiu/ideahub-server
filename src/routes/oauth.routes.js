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

function redirectSuccess(res, token) {
  const client = process.env.CLIENT_BASE_URL || "http://localhost:5173";
  // token 放 query：简单直接；之后你也可以升级为 HttpOnly cookie
  return res.redirect(`${client}/oauth/callback?token=${encodeURIComponent(token)}`);
}

function redirectFail(res, error, message) {
  const client = process.env.CLIENT_BASE_URL || "http://localhost:5173";
  const u = `${client}/oauth/callback?error=${encodeURIComponent(error)}&message=${encodeURIComponent(
    message || ""
  )}`;
  return res.redirect(u);
}

// ---------------- Google ----------------
router.get(
  "/oauth/google",
  passport.authenticate("google", {
    session: true,
    scope: ["profile", "email"],
    prompt: "select_account",
  })
);

router.get(
  "/oauth/google/callback",
  passport.authenticate("google", { session: true, failureRedirect: "/api/auth/oauth/fail?provider=google" }),
  async (req, res) => {
    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing google profile");

      const googleId = profile.id;
      const emails = profile.emails || [];
      const email = (emails[0]?.value || "").toLowerCase();
      const avatarUrl = profile.photos?.[0]?.value || "";

      if (!email) return redirectFail(res, "oauth_failed", "Google email not available");

      // 1) 已绑定 googleId 的用户
      let user = await User.findOne({ "providers.google": googleId });

      // 2) 否则按 email 合并/绑定（已有账号直接绑定 Google）
      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          user.providers.google = googleId;
          if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
          user.emailVerified = true; // Google 登录视为邮箱已验证
          await user.save();
        }
      }

      // 3) 仍没有 → 创建新用户
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
      return redirectSuccess(res, token);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "Google callback error");
    }
  }
);

// ---------------- GitHub ----------------
router.get("/oauth/github", passport.authenticate("github", { session: true }));

router.get(
  "/oauth/github/callback",
  passport.authenticate("github", { session: true, failureRedirect: "/api/auth/oauth/fail?provider=github" }),
  async (req, res) => {
    try {
      const profile = req.user?.profile;
      if (!profile) return redirectFail(res, "oauth_failed", "Missing github profile");

      const githubId = profile.id;
      const avatarUrl = profile.photos?.[0]?.value || "";

      // GitHub email：可能拿不到公开 email，passport-github2 有时会放到 profile.emails
      const email = (profile.emails?.[0]?.value || "").toLowerCase();

      // 1) 已绑定 githubId
      let user = await User.findOne({ "providers.github": githubId });

      // 2) 若有 email，按 email 合并/绑定
      if (!user && email) {
        user = await User.findOne({ email });
        if (user) {
          user.providers.github = githubId;
          if (!user.avatarUrl && avatarUrl) user.avatarUrl = avatarUrl;
          // GitHub 有 email 就当验证过；拿不到 email 就不标 true
          if (email) user.emailVerified = true;
          await user.save();
        }
      }

      // 3) 仍没有 → 创建新用户
      if (!user) {
        // 如果 GitHub 没 email：我们创建一个“占位 email”，避免破坏你的 userSchema required+unique
        // 之后你可以做“补充邮箱”页面，让用户绑定真实邮箱
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
      return redirectSuccess(res, token);
    } catch (e) {
      return redirectFail(res, "oauth_failed", e.message || "GitHub callback error");
    }
  }
);

router.get("/oauth/fail", (req, res) => {
  const provider = req.query.provider || "oauth";
  return redirectFail(res, "oauth_failed", `${provider} login failed`);
});

module.exports = router;
