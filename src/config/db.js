const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI in .env");

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri);
  console.log("✅ MongoDB connected");
}

module.exports = { connectDB };
