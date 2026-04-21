const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 40, index: true },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    memberCount: { type: Number, default: 1, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Group", groupSchema);