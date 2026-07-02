const mongoose = require("mongoose");

const groupInviteSchema = new mongoose.Schema(
  {
    groupSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    code: { type: String, required: true, unique: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

groupInviteSchema.index({ groupSlug: 1, owner: 1, active: 1 });

module.exports = mongoose.model("GroupInvite", groupInviteSchema);