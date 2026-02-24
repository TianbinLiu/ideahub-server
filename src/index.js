require("dotenv").config();
const app = require("./app");
const { connectDB } = require("./config/db");
const TagLeaderboard = require("./models/TagLeaderboard");
const { startAiWorker } = require("./workers/aiReview.worker");

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await connectDB();
    // Cleanup empty leaderboards on startup
    try {
      const result = await TagLeaderboard.deleteMany({
        $or: [{ entries: { $exists: false } }, { entries: { $size: 0 } }],
      });
      if (result?.deletedCount) {
        console.log(`Cleaned empty leaderboards: ${result.deletedCount}`);
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
