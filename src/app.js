//app.js

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieSession = require("cookie-session");
const passport = require("passport");

const healthRoutes = require("./routes/health.routes");
const ideaRoutes = require("./routes/ideas.routes");
const authRoutes = require("./routes/auth.routes");
const meRoutes = require("./routes/me.routes");
const { notFound, errorHandler } = require("./middleware/error");
const companyRoutes = require("./routes/company.routes");
const notificationsRoutes = require("./routes/notifications.routes");
const adminRoutes = require("./routes/admin.routes");
const authOtpRoutes = require("./routes/authOtp.routes");
const oauthRoutes = require("./routes/oauth.routes");
const { initPassport } = require("./config/passport");

const app = express();

app.use(cors());
app.use(express.json());
app.use(helmet());

// ✅ cookie session for OAuth state
app.use(
  cookieSession({
    name: "ideahub_oauth",
    keys: [process.env.COOKIE_SESSION_KEY || process.env.JWT_SECRET || "dev_key"],
    maxAge: 10 * 60 * 1000, // 10 minutes
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  })
);

// ✅ passport
initPassport();
app.use(passport.initialize());
app.use(passport.session());

app.use("/api", healthRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/auth", authOtpRoutes);

// ✅ OAuth routes under /api/auth
app.use("/api/auth", oauthRoutes);

app.use("/api/me", meRoutes);
app.use("/api/company", companyRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai-jobs", require("./routes/aiJobs.routes"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
