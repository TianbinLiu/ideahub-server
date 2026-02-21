const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true }, // 接收者
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // 触发者
    ideaId: { type: mongoose.Schema.Types.ObjectId, ref: "Idea" },   // 关联idea

    type: {
      type: String,
      required: true,
      enum: ["LIKE", "COMMENT", "BOOKMARK", "INTEREST", "MENTION", "INVITE"],
      index: true,
    },

    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

NotificationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
