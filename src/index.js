require("dotenv").config();
const app = require("./app");
const { connectDB } = require("./config/db");
const TagLeaderboard = require("./models/TagLeaderboard");
const LeaderboardPost = require("./models/LeaderboardPost");
const TagVote = require("./models/TagVote");
const { startAiWorker } = require("./workers/aiReview.worker");

const PORT = process.env.PORT || 4000;

async function start() {
  try {
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
