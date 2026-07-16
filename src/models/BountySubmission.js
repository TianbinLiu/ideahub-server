// src/models/BountySubmission.js
// 赏金提交——猎人对某个 bounty 的领取提交（发言文本 + 截图存证）。
const mongoose = require("mongoose");

const BOUNTY_SUBMISSION_STATUSES = ["pending", "approved", "rejected"];

const bountySubmissionSchema = new mongoose.Schema(
  {
    bounty: { type: mongoose.Schema.Types.ObjectId, ref: "Bounty", required: true, index: true },
    hunter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    speechText: { type: String, default: "", trim: true, maxlength: 4000 },
    screenshotUrl: { type: String, default: "" },
    note: { type: String, default: "", trim: true, maxlength: 2000 },
    status: { type: String, enum: BOUNTY_SUBMISSION_STATUSES, default: "pending", index: true },
  },
  { timestamps: true }
);

bountySubmissionSchema.index({ bounty: 1, hunter: 1 });
bountySubmissionSchema.index({ bounty: 1, createdAt: -1 });

module.exports = mongoose.model("BountySubmission", bountySubmissionSchema);
module.exports.BOUNTY_SUBMISSION_STATUSES = BOUNTY_SUBMISSION_STATUSES;
