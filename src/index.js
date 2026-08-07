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

/**
 * 清理没有任何提名的排行榜。纯维护性工作，不影响对外服务能力，
 * 因此在 listen 之后异步执行 —— 挡在 listen 前面只会拉长部署的停机窗口。
 * 失败只告警：清理不成功不该让服务起不来。
 */
async function cleanupEmptyLeaderboards() {
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
}

async function start() {
  try {
    assertProductionConfig();
    await syncProjectDocs();

    // 验证 Cloudinary 配置
    validateCloudinaryConfig();

    await connectDB();

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

    // ★ 排行榜清理挪到 listen 【之后】异步跑。
    //
    // 它原先挡在 app.listen() 前面：一次 distinct + 两次 deleteMany，
    // 而 pm2 restart 是「停旧进程 → 起新进程」，端口没打开之前 nginx 只能返回 502。
    // 实测（服务器本地 50ms 采样）：重启期间不可用约 9.9 秒，全是连接被拒。
    // 这是纯维护性清理，晚几秒执行没有任何影响，却让每次部署都多停机好几秒。
    // 放到监听之后，端口一就绪就能接客，清理在后台自己跑完。
    cleanupEmptyLeaderboards();
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

/**
 * 优雅退出：让在途请求跑完，同时尽快把监听端口让给新进程。
 *
 * ★ 关于 pm2 restart 期间的 502（务必知情）：
 *   `pm2 restart` 在 fork 模式下就是「停旧进程 → 起新进程」，中间必然有空档，
 *   nginx 在空档里只能返回 502。这是重启方式本身决定的，不是本函数的缺陷 ——
 *   要做到零停机需要 cluster 模式 + `pm2 reload`（见 SECURITY_HARDENING.md 的待办）。
 *   本函数只能把空档【尽量缩短】，不能消除它。
 *
 * ★ 为什么加 closeIdleConnections()：
 *   `server.close()` 只停止接受新连接，已建立的连接要等对端断开才释放。
 *   nginx 用长连接反代，理论上可能拖长退出时间。
 *   （诚实说明：本地用「客户端持有 keep-alive 连接」的场景复现过，两种写法都
 *    毫秒级关闭，【没有】复现出卡住 —— 所以这不是已证实的故障原因，
 *    加上它是防御性的标准做法，不是针对某个已确诊问题的修复。）
 *   closeIdleConnections() 立刻掐掉空闲连接，在途请求留 DRAIN_MS 跑完，
 *   到点由 closeAllConnections() 兜底。两个 API 需 Node ≥ 18.2（生产 v20.20.2）。
 */
function setupGracefulShutdown(server) {
  let shuttingDown = false;

  /** 留给在途请求跑完的时间；超过就强断，不能让部署一直卡着 */
  const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 5000);

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} 收到，开始优雅退出…`);

    let exited = false;
    const finish = async (code, why) => {
      if (exited) return;
      exited = true;
      try {
        await require("mongoose").disconnect();
        console.log(`已断开数据库连接，退出（${why}）`);
      } catch (e) {
        console.warn("断开数据库连接失败:", e.message || e);
      }
      process.exit(code);
    };

    // 1. 停止接受新连接
    server.close(() => finish(0, "连接已排空"));

    // 2. 立刻掐掉空闲的 keep-alive —— 这一步是关键，没有它 close() 可能永远不回调
    server.closeIdleConnections?.();

    // 3. 在途请求的宽限期，到点强断剩余连接
    const force = setTimeout(() => {
      console.warn(`优雅退出：${DRAIN_MS}ms 内仍有连接未结束，强制关闭`);
      server.closeAllConnections?.();
      finish(0, "超时强断");
    }, DRAIN_MS);
    force.unref();
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
