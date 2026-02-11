const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, unique: true },
    email: { type: String, required: true, trim: true, unique: true },
    passwordHash: { type: String, default: "" }, // Phase 2 再真正使用
    role: { type: String, enum: ["user", "company", "admin"], default: "user" },
    bio: { type: String, default: "" },
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

module.exports = mongoose.model("User", userSchema);
