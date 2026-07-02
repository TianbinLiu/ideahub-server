const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 40, index: true },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    visibility: { type: String, enum: ["public", "private", "unlisted"], default: "private", index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    adminIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],
    joinCode: { type: String, default: "", trim: true, select: false },
    memberCount: { type: Number, default: 1, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Group", groupSchema);