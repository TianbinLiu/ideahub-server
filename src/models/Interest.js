const mongoose = require("mongoose");

const interestSchema = new mongoose.Schema(
  {
    companyUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    idea: { type: mongoose.Schema.Types.ObjectId, ref: "Idea", required: true },
    message: { type: String, default: "", trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// 同一 company + idea 只能一条（切换用）
interestSchema.index({ companyUser: 1, idea: 1 }, { unique: true });

module.exports = mongoose.model("Interest", interestSchema);
