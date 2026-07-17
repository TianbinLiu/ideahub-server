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

    // 审批通过时【实际入账】的点数，审批那一刻写死。
    // 为什么不直接用 Bounty.reward 显示：reward 事后可以被发布者改，
    // 用它去渲染「已入账 N 点」就会对猎人说一个和账本不符的数。这里存的是账本上的真值。
    awardedPoints: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

bountySubmissionSchema.index({ bounty: 1, hunter: 1 });
bountySubmissionSchema.index({ bounty: 1, createdAt: -1 });

module.exports = mongoose.model("BountySubmission", bountySubmissionSchema);
module.exports.BOUNTY_SUBMISSION_STATUSES = BOUNTY_SUBMISSION_STATUSES;
