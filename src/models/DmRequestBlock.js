const mongoose = require("mongoose");

const DmRequestBlockSchema = new mongoose.Schema(
  {
    blockerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    blockedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

DmRequestBlockSchema.index({ blockerUserId: 1, blockedUserId: 1 }, { unique: true });

module.exports = mongoose.model("DmRequestBlock", DmRequestBlockSchema);
