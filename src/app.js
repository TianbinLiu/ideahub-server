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
const messagesRoutes = require("./routes/messages.routes");
const scraperRoutes = require("./routes/scraper.routes");
const uploadsRoutes = require("./routes/uploads.routes");
const workshopRoutes = require("./routes/workshop.routes");
const groupsRoutes = require("./routes/groups.routes");
const arenaRoutes = require("./routes/arena.routes");
const scenarioRoutes = require("./routes/scenario.routes");
const standpointRoutes = require("./routes/standpoint.routes");
const bountyRoutes = require("./routes/bounty.routes");
const speakingStyleRoutes = require("./routes/speakingStyle.routes");
const personaRoutes = require("./routes/persona.routes");
const memeRoutes = require("./routes/meme.routes");
const { initPassport } = require("./config/passport");

const app = express();
app.set("trust proxy", 1);

// CORS 白名单。原先是裸 cors()，等于 Access-Control-Allow-Origin: *，
// 任意站点的脚本都能读我们 API 的响应。鉴权走 Bearer 头（不走 cookie）所以没有
// 经典 CSRF 面，但"任意来源可读响应"本身就不该开着。
// CORS_ORIGINS 逗号分隔；未配置时回退到 CLIENT_BASE_URL；都没有则只允许同源（无 origin 的请求）。
const allowedOrigins = String(process.env.CORS_ORIGINS || process.env.CLIENT_BASE_URL || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // 无 Origin 头 = 同源请求 / 服务端调用 / App 原生请求（Capacitor 壳），放行
    if (!origin) return cb(null, true);
    if (!allowedOrigins.length) return cb(null, true); // 未配置时不阻断，避免误伤既有部署
    return cb(null, allowedOrigins.includes(origin.replace(/\/+$/, "")));
  },
  credentials: false,
}));

// 分支视频发布体里带 dataURL 首尾帧（MB 级），默认 100kb 会 413。
// 只给 /api/branch 放宽，必须排在全局 express.json() 之前（body-parser 解析过就不会重复解析）。
//
// ★ 大 body 只对【持有效签名 token】的请求开放。
//   body 解析发生在路由鉴权之前，所以原来的写法等于"任何匿名者 POST /api/branch/xxx
//   都能让服务端缓冲并解析 50MB" —— 几个并发就能把进程内存打爆。
//   这里先做一次纯签名校验（jwt.verify，不查库，微秒级）作为闸门：
//   验不过的请求走 1mb 的常规上限，验得过的才放宽。真正的鉴权仍由路由的
//   requireAuth 负责（它还要查 tokenVersion / deactivatedAt），此处只管"值不值得为你分配内存"。
const jwt = require("jsonwebtoken");
const bigJson = express.json({ limit: process.env.BRANCH_JSON_LIMIT || "50mb" });
const smallJson = express.json({ limit: "1mb" });

app.use("/api/branch", (req, res, next) => {
  const [type, token] = String(req.headers.authorization || "").split(" ");
  if (type === "Bearer" && token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
      return bigJson(req, res, next);
    } catch {
      /* 签名无效：按匿名处理，走小上限 */
    }
  }
  return smallJson(req, res, next);
});

app.use(express.json({ limit: "1mb" }));
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// 提供静态文件服务 - 上传的文件（配置CORS）
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Ensure cross-origin pages can embed uploaded images without CORP blocking.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  // ★ 这个目录托管的是【用户上传的内容】，且带 ACAO:*。万一有文件绕过了上传侧的
  //   类型白名单（components.controller.js 的 zip 解压、multer 的 MIME 校验），
  //   这道 CSP 保证它即便被当成 HTML 渲染也执行不了脚本、加载不了外部资源。
  //   sandbox 还会把它放进不透明源，拿不到主站的 localStorage/cookie。
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(path.join(__dirname, '../uploads'), {
  // 用户可控文件名不参与 index/重定向推断，减少一层意外行为
  index: false,
  dotfiles: 'deny',
}));


// ✅ passport
initPassport();
app.use(passport.initialize());

app.use("/api", healthRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/search", require("./routes/search.routes"));
app.use("/api/feed", require("./routes/feed.routes"));
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
app.use("/api/messages", messagesRoutes);
app.use("/api/scraper", scraperRoutes);
app.use("/api/uploads", uploadsRoutes);
app.use("/api/workshop", workshopRoutes);
app.use("/api/groups", groupsRoutes);
app.use("/api/arena", arenaRoutes);
app.use("/api/scenarios", scenarioRoutes);
app.use("/api/standpoint", standpointRoutes);
app.use("/api/bounties", bountyRoutes);
app.use("/api/speaking-style", speakingStyleRoutes);
app.use("/api/personas", personaRoutes);
app.use("/api/memes", memeRoutes);
app.use("/api/branch", require("./routes/branchVideo.routes"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
