/**
 * app.js - Express应用配置中心
 * 
 * 📖 AI开发规范：修改前必读 /.ai-instructions.md 和 PROJECT_STRUCTURE.md
 * 🔄 修改后同步更新：PROJECT_STRUCTURE.md 相关章节
 * 
 * 职责：
 * - 配置Express中间件链
 * - 注册所有路由模块
 * - 错误处理中间件
 * - CORS和安全配置
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const passport = require("passport");
const path = require("path");

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
const tagRankRoutes = require("./routes/tagRank.routes");
const usersRoutes = require("./routes/users.routes");
const { initPassport } = require("./config/passport");

const app = express();

app.use(cors());
app.use(express.json());
app.use(helmet());

// 提供静态文件服务 - 上传的文件
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));


// ✅ passport
initPassport();
app.use(passport.initialize());

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
app.use("/api/tag-rank", tagRankRoutes);
app.use("/api/users", usersRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
