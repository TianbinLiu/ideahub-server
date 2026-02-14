//User.js

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, unique: true },
    email: { type: String, required: true, trim: true, unique: true },

    passwordHash: { type: String, default: "" },

    role: { type: String, enum: ["user", "company", "admin"], default: "user" },
    bio: { type: String, default: "" },

    // ✅ OAuth providers
    providers: {
      google: { type: String, default: "" }, // google sub
      github: { type: String, default: "" }, // github id
    },

    avatarUrl: { type: String, default: "" },

    // ✅ 以后你做“邮箱必须验证码验证后才能登录”会用到
    emailVerified: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } }
);

module.exports = mongoose.model("User", userSchema);
