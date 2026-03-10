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

async function start() {
  try {
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
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();
startAiWorker();
