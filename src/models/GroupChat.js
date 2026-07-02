const mongoose = require("mongoose");

const groupChatSchema = new mongoose.Schema(
  {
    groupSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", trim: true, maxlength: 300 },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    memberCount: { type: Number, default: 1, min: 0 },
  },
  { timestamps: true }
);

groupChatSchema.index({ groupSlug: 1, name: 1 });

module.exports = mongoose.model("GroupChat", groupChatSchema);