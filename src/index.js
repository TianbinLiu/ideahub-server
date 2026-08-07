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

// 启动自检的实现在 config/preflight.js —— 抽出去是为了能用
// `npm run check:config` 在【部署之前】单独跑一次，而不是等部署失败才发现缺什么。
const { assertProductionConfig } = require("./config/preflight");

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
    // ★ 显式绑定监听地址，默认只听 127.0.0.1。
    //
    // 原先是 app.listen(PORT)，等于监听 0.0.0.0（所有网卡）—— 4000 端口对公网
    // 是否可达，就全靠云安全组那一条规则。规则被改错、或换台机器忘了配，API 就
    // 直接裸露在公网上，且【绕过 nginx 的全部安全响应头、也绕过 Cloudflare 的
    // WAF 与源站隐藏】。本进程只由同机 nginx 反代（proxy_pass http://127.0.0.1:4000），
    // 绑本地不影响任何调用方，却把"单靠安全组"变成了两层防护。
    //
    // 容器化部署（需要跨容器访问）时用 BIND_HOST=0.0.0.0 覆盖。
    const HOST = process.env.BIND_HOST || "127.0.0.1";
    const server = app.listen(PORT, HOST, () => {
      console.log(`Server listening on http://${HOST}:${PORT}`);
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
