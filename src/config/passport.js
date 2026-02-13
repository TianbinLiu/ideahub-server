const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function initPassport() {
  // Google
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${must("SERVER_BASE_URL")}/api/auth/oauth/google/callback`,
        },
        async (accessToken, refreshToken, profile, done) => {
          // 我们不在这里操作 DB，直接把 profile 交给 callback route 去处理
          return done(null, {
            provider: "google",
            profile,
          });
        }
      )
    );
  }

  // GitHub
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: `${must("SERVER_BASE_URL")}/api/auth/oauth/github/callback`,
          scope: ["user:email"],
        },
        async (accessToken, refreshToken, profile, done) => {
          return done(null, {
            provider: "github",
            profile,
          });
        }
      )
    );
  }

  // 这里不做持久 session 登录，所以 serialize/deserialize 不必写复杂
  passport.serializeUser((obj, done) => done(null, obj));
  passport.deserializeUser((obj, done) => done(null, obj));
}

module.exports = { initPassport };
