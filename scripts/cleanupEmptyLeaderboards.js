require("dotenv").config();
const mongoose = require("mongoose");
const TagLeaderboard = require("../src/models/TagLeaderboard");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI (or MONGO_URI)");

  await mongoose.connect(uri);

  const filter = {
    $or: [
      { entries: { $exists: false } },
      { entries: { $size: 0 } },
    ],
  };

  const result = await TagLeaderboard.deleteMany(filter);
  console.log("Deleted empty leaderboards:", result.deletedCount || 0);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
