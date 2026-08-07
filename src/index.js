/**
 * index.js - 服务器启动入口
 * 
 * 📖 AI开发规范：修改前必读 /.ai-instructions.md 和 PROJECT_STRUCTURE.md
 * 🔄 修改后同步更新：PROJECT_STRUCTURE.md 相关章节
 * 
 * 职责：
 * - 启动Express服务器
 * - 连接MongoDB数据库
 * - 启动后台任务（AI Worker等）
 */

require("dotenv").config();

// 可选：覆盖 Node 的 DNS 服务器（逗号分隔）。不设就完全按系统走，生产不受影响。
//
// 为什么需要：Node 的 dns.resolve*（c-ares）用的是它自己那份服务器列表，和 Windows
// 解析器不是一回事。某些机器上（开了 WSL/Hyper-V 的 ICS DNS 代理时）c-ares 会选中
// 127.0.0.1，而那个代理对本机查询一律 REFUSED —— 表现就是浏览器一切正常、Node 却
// `querySrv ECONNREFUSED`，mongodb+srv:// 连不上。设一下这个变量即可绕过，
// 不用改连接串、也不用动系统网络设置。
if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (servers.length) {
    require("dns").setServers(servers);
    console.log("🌐 DNS servers overridden:", servers.join(", "));
  }
}

const fs = require("fs").promises;
const path = require("path");
const app = require("./app");
const { connectDB } = require("./config/db");
const { validateCloudinaryConfig } = require("./config/cloudinary");
const TagLeaderboard = require("./models/TagLeaderboard");
const LeaderboardPost = require("./models/LeaderboardPost");
const TagVote = require("./models/TagVote");
const { startAiWorker } = require("./workers/aiReview.worker");

const PORT = process.env.PORT || 4000;

async function syncProjectDocs() {
  const destPath = path.join(process.cwd(), "PROJECT_STRUCTURE.md");
  const candidates = [
    path.join(process.cwd(), "..", "PROJECT_STRUCTURE.md"),
    path.join(process.cwd(), "..", "..", "PROJECT_STRUCTURE.md"),
    path.join(__dirname, "..", "..", "PROJECT_STRUCTURE.md"),
    path.join(__dirname, "..", "..", "..", "PROJECT_STRUCTURE.md"),
  ];

  let sourcePath = null;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      sourcePath = candidate;
      break;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
    }
  }

  if (!sourcePath || sourcePath === destPath) {
    return;
  }

  try {
    await fs.copyFile(sourcePath, destPath);
    console.log(`Synced PROJECT_STRUCTURE.md to server root: ${destPath}`);
  } catch (err) {
    console.warn("Project docs sync failed:", err.message || err);
  }
}

/**
 * 启动自检：把「配错了但能跑起来」变成「配错了就起不来」。
 *
 * 这些值以前是缺了也照常启动、等到第一个请求进来才炸（JWT_SECRET），
 * 或者更糟——静默降级成开发模式（SMS provider=dev 会把验证码打进日志，
 * 谁能看日志谁就能登录任意手机账号）。生产环境宁可拒绝启动。
 */
function assertProductionConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const problems = [];

  const secret = process.env.JWT_SECRET || "";
  if (!secret) problems.push("JWT_SECRET 未设置");
  else if (secret.length < 32) problems.push(`JWT_SECRET 过短（${secret.length} 字符，至少 32）`);
  else if (/^(replace|change|example|test|secret|dev)/i.test(secret)) problems.push("JWT_SECRET 仍是示例值");

  if (isProd) {
    if (!process.env.OTP_PEPPER || process.env.OTP_PEPPER === "dev_pepper_change_me") {
      problems.push("OTP_PEPPER 未设置或仍是默认值（6 位验证码的 sha256 可离线暴破）");
    }
    if (!process.env.SMS_PROVIDER || process.env.SMS_PROVIDER === "dev") {
      problems.push("SMS_PROVIDER 未配置真实短信通道（dev 通道会把验证码写进日志）");
    }
    if (!process.env.CORS_ORIGINS && !process.env.CLIENT_BASE_URL) {
      problems.push("CORS_ORIGINS / CLIENT_BASE_URL 均未设置，CORS 将对所有来源开放");
    }
  }

  if (problems.length) {
    const msg = problems.map((p) => `  - ${p}`).join("\n");
    if (isProd) {
      console.error(`❌ 生产配置自检未通过：\n${msg}`);
      process.exit(1);
    }
    console.warn(`⚠️  配置自检提示（非生产环境，仅告警）：\n${msg}`);
  }
}

async function start() {
  try {
    assertProductionConfig();
    await syncProjectDocs();

    // 验证 Cloudinary 配置
    validateCloudinaryConfig();

    await connectDB();
    // Cleanup leaderboards with no nominations on startup
    try {
      await Promise.all([
        LeaderboardPost.deleteMany({ tagsKey: "" }),
        TagVote.deleteMany({ tagsKey: "" }),
      ]);
      const activeTagsKeys = (await LeaderboardPost.distinct("tagsKey")).filter(Boolean);
      const result = await TagLeaderboard.deleteMany({ tagsKey: { $nin: activeTagsKeys } });
      if (result?.deletedCount) {
        console.log(`Cleaned leaderboards with no nominations: ${result.deletedCount}`);
      }
    } catch (cleanupErr) {
      console.warn("Cleanup empty leaderboards failed:", cleanupErr.message || cleanupErr);
    }
    const server = app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });

    // ★ AI worker 移到这里：原来它在 start() 之外被调用，不等 connectDB() 完成，
    //   数据库连不上时照样开始轮询 AiJob，产生一串连接错误噪音。
    startAiWorker();

    setupGracefulShutdown(server);
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

/**
 * 优雅退出。没有这段时，每次部署（PM2 reload / 容器滚动更新）都会硬切在途请求：
 * 用户看到的是随机的 502，而正在跑的 AiJob 会永远停留在 running 状态没人回收。
 */
function setupGracefulShutdown(server) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} 收到，开始优雅退出…`);

    // 强制超时：极端情况下（长连接不断开）不能无限等
    const force = setTimeout(() => {
      console.error("优雅退出超时（15s），强制结束");
      process.exit(1);
    }, 15000);
    force.unref();

    server.close(async () => {
      try {
        await require("mongoose").disconnect();
        console.log("已断开数据库连接，退出");
      } catch (e) {
        console.warn("断开数据库连接失败:", e.message || e);
      }
      process.exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // 兜底：未捕获异常不应让进程带着不确定状态继续服务
  process.on("unhandledRejection", (reason) => {
    console.error("未处理的 Promise 拒绝:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("未捕获异常:", err);
    shutdown("uncaughtException");
  });
}

start();
