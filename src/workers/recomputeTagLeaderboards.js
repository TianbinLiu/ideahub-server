require("dotenv").config();
const { connectDB } = require("../config/db");
const TagVote = require("../models/TagVote");
const TagLeaderboard = require("../models/TagLeaderboard");

async function recompute() {
  await connectDB();
  console.log("Recomputing tag leaderboards...");

  // compute global leaderboard (no tags)
  try {
    const globalAgg = await TagVote.aggregate([
      { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
      { $sort: { score: -1 } },
      { $limit: 500 },
    ]);
    const globalEntries = globalAgg.map(a => ({ idea: a._id, score: a.score, votes: a.votes }));
    await TagLeaderboard.findOneAndUpdate({ tagsKey: "" }, { $set: { tagsKey: "", tags: [], entries: globalEntries, computedAt: new Date() } }, { upsert: true });
    console.log("Global leaderboard computed", globalEntries.length);
  } catch (e) {
    console.error("global leaderboard failed", e.message || e);
  }

  // compute per-tagsKey (from TagVote distinct)
  try {
    const keys = await TagVote.distinct("tagsKey");
    console.log("Found tagsKey count:", keys.length);
    for (const tk of keys) {
      if (!tk) continue;
      const agg = await TagVote.aggregate([
        { $match: { tagsKey: tk } },
        { $group: { _id: "$idea", score: { $sum: "$vote" }, votes: { $sum: 1 } } },
        { $sort: { score: -1 } },
        { $limit: 500 },
      ]);
      const entries = agg.map(a => ({ idea: a._id, score: a.score, votes: a.votes }));
      const tags = tk ? tk.split("|") : [];
      await TagLeaderboard.findOneAndUpdate({ tagsKey: tk }, { $set: { tagsKey: tk, tags, entries, computedAt: new Date() } }, { upsert: true });
      console.log("Computed leaderboard for", tk, entries.length);
    }
  } catch (e) {
    console.error("per-key leaderboards failed", e.message || e);
  }

  console.log("Done recomputing.");
  process.exit(0);
}

recompute().catch((e) => {
  console.error("recompute failed:", e.message || e);
  process.exit(1);
});
