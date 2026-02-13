require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const email = process.env.ADMIN_EMAIL;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) throw new Error("Set ADMIN_EMAIL and ADMIN_PASSWORD");

  let user = await User.findOne({ email });
  if (user) {
    user.role = "admin";
    await user.save();
    console.log("Updated existing user to admin:", user.email);
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    user = await User.create({ username, email, passwordHash, role: "admin" });
    console.log("Created admin:", user.email);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
