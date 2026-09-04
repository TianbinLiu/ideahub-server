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
  // ★ 跨域下自定义响应头默认对 JS **不可见**（只能读到那几个 CORS 安全头）。
  //   APK 里 WebView 的源是 https://localhost，打 api.ideahubs.org 是跨域的，
  //   不放行这两个头的话 /api/ark 回来的余额读不到，App 的钱包镜像就只能靠
  //   每次调用后再 GET 一次 —— 多一趟往返，还会在两次请求之间显示旧余额。
  exposedHeaders: ["X-Wallet-Plan", "X-Wallet-Addon"],
}));

// 两处需要放宽 body 上限（默认 100kb 会 413），且必须排在全局 express.json() 之前
// ——body-parser 解析过一次就不会重复解析，排在后面等于没挂：
//   /api/branch  发布体里带 dataURL 首尾帧（MB 级）
//   /api/ark     Seedance 任务创建请求带 base64 首尾帧（压到 720p 后仍有 2-3MB）
// 「大 body 只对持有效签名 token 的请求开放」这条闸门的实现见 middleware/bigJson.js
// （两处共用一份：改了阈值或判据要两边同时生效）。
const { jsonGate } = require("./middleware/bigJson");
app.use("/api/branch", jsonGate);
app.use("/api/ark", jsonGate);
// 真人视频档：创建体带 base64 首帧/参考图（与 /api/ark 同理，不放宽就是 413）
app.use("/api/minimax", jsonGate);
app.use("/api/runway", jsonGate);

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
// 安卓 App 的版本清单（无需登录，检查更新发生在登录之前）
app.use("/api/app", require("./routes/appRelease.routes"));
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
// 举报（视频 / 评论 / 弹幕）。两个入口、一份实现（见 routes/report.routes.js）：
// 用户提交挂在 /api/branch 下，管理端的列队与处理挂在既有的 /api/admin 门后面。
// ★ 管理端这条**必须排在 `app.use("/api/admin", adminRoutes)` 之前**：admin.routes.js
//   开头就是 `router.use(requireAuth, requireRole)`，排在它后面的话每个请求会白白
//   多做一次 requireAuth（多一次 User.findById），行为一样但平白多一趟库。
const reportRoutes = require("./routes/report.routes");
app.use("/api/admin/branch/reports", reportRoutes.adminRouter);
app.use("/api/branch/reports", reportRoutes.publicRouter);
// 分支视频的其余管理端：下架 / 撤销下架 / 下架列表 / 平台统计。
// ★ 与上面那条同一个 base（`/api/admin/branch`），后台控制台只用记一个前缀；
//   同样必须排在 `app.use("/api/admin", adminRoutes)` **之前**，理由与上面逐字相同。
app.use("/api/admin/branch", require("./routes/branchAdmin.routes"));
app.use("/api/admin", adminRoutes);
app.use("/api/ai-jobs", require("./routes/aiJobs.routes"));
app.use("/api/tag-rank", tagRankRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/messages", messagesRoutes);
app.use("/api/blocks", require("./routes/blocks.routes"));
// 首页看板娘数字人：GET /config 游客可探测、POST /chat 需登录且按用户限流（SSE）
app.use("/api/companion", require("./routes/companion.routes"));
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
// 白模模板（blockout r2v）：同一个 /api/branch base（App 只记一个前缀），
// 路径全在 /templates 下，与 /videos /cards /decks 不重叠
app.use("/api/branch", require("./routes/branchTemplate.routes"));
// 提示词方案（人物卡设定图的出图配方）与它的广场。同一个 /api/branch base，
// 路径全在 /schemes 下，与 /videos /cards /decks /templates 不重叠
app.use("/api/branch", require("./routes/promptScheme.routes"));
// 出片技能（画布 agent 指令的封装）与它的广场。同 base，路径全在 /skills 下
app.use("/api/branch", require("./routes/agentSkill.routes"));
// 成片合并（把已转存的 N 段拼成一条）。同一个 /api/branch base，路径全在 /compose 下。
// 端上原来用 MediaRecorder 实时重录，弱网/低端机上不可靠（2026-08-21 真机复盘）
app.use("/api/branch", require("./routes/branchCompose.routes"));
// 工坊 NPC 的语音合成。原来只是 app 仓 vite dev 的一个中间件，打成 APK 后无人应答
// （真机上 NPC 全程哑巴），且密钥不能进前端包，所以收到服务端
app.use("/api/tts", require("./routes/tts.routes"));
// 火山方舟（出图/出视频/对话）代理。与 /api/tts 同一个理由、同一个事故：
// 原来是 app 仓 vite dev 的代理，APK 里不存在，而 Capacitor 对未命中路径回 200+index.html，
// 表现成"第 1 段生成失败：Unexpected token '<'"。白名单转发，不是通用反向代理。
app.use("/api/ark", require("./routes/ark.routes"));
// 真人肖像授权（素材库）：生成邀约二维码 / 查授权状态。同一个 /api/ark base，
// 路径全在 /portrait 下，与代理不重叠。走 AK/SK 的 OpenAPI（arkOpenApi.service），
// 不烧 token、不进钱包 —— 与 /api/ark 代理是两套认证，别混。
app.use("/api/ark", require("./routes/arkPortrait.routes"));
// 真人视频档的两家供应商代理（MiniMax 海螺 / Runway）。当前是**脚手架**：key 还没申请，
// 未配时全部 501，App 据此把真人档置灰。与 /api/ark 同款纪律：白名单转发、密钥只在
// 服务端；★ 接上钱包扣费之前不要在生产配真 key（见两个文件头）。Runway 的
// contentModeration 由服务端钉死不透传——那是产品与合规决定，见 runway.routes.js。
app.use("/api/minimax", require("./routes/minimax.routes"));
app.use("/api/runway", require("./routes/runway.routes"));
// AI token 钱包。★ 必须在服务端：它以前长在 app 的 IndexedDB 里，等于把收银台交给顾客，
// 而每次方舟调用都是真金白银。扣费发生在 /api/ark 转发之前（见 ark.routes 的 billedForward）
app.use("/api/me/wallet", require("./routes/wallet.routes"));
// 充值订单与支付回调。★ 发币的唯一入口是这里的回调结算，钱包路由已经不发币了。
// 回调端点无鉴权（渠道服务器不带 token），安全全压在渠道 adapter 的验签上，
// 所以未注册的渠道一律拒绝——见 services/payment/channels.js 的文件头。
app.use("/api/pay", require("./routes/pay.routes"));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
