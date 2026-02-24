require("dotenv").config();
const mongoose = require("mongoose");
const TagLeaderboard = require("../src/models/TagLeaderboard");
const LeaderboardPost = require("../src/models/LeaderboardPost");
const TagVote = require("../src/models/TagVote");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI (or MONGO_URI)");

  await mongoose.connect(uri);

  await Promise.all([
    LeaderboardPost.deleteMany({ tagsKey: "" }),
    TagVote.deleteMany({ tagsKey: "" }),
  ]);
  const activeTagsKeys = (await LeaderboardPost.distinct("tagsKey")).filter(Boolean);
  const result = await TagLeaderboard.deleteMany({ tagsKey: { $nin: activeTagsKeys } });
  console.log("Deleted leaderboards with no nominations:", result.deletedCount || 0);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
