const mongoose = require("mongoose");

const groupJoinReferralSchema = new mongoose.Schema(
  {
    groupSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    invitee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    invite: { type: mongoose.Schema.Types.ObjectId, ref: "GroupInvite", default: null },
    joinMethod: { type: String, enum: ["invite", "group_code"], default: "invite" },
  },
  { timestamps: true }
);

groupJoinReferralSchema.index({ groupSlug: 1, invitee: 1 }, { unique: true });

module.exports = mongoose.model("GroupJoinReferral", groupJoinReferralSchema);