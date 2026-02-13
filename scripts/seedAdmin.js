require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Missing MONGODB_URI (or MONGODB_URI)");

  await mongoose.connect(uri);

  const email = process.env.ADMIN_EMAIL;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD in env");
  }

  let user = await User.findOne({ email });

  if (user) {
    user.role = "admin";
    if (!user.passwordHash) {
      user.passwordHash = await bcrypt.hash(password, 10);
    }
    await user.save();
    console.log("Updated user to admin:", user.email);
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    user = await User.create({
      username,
      email,
      passwordHash,
      role: "admin",
      bio: "",
    });
    console.log("Created admin:", user.email);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
