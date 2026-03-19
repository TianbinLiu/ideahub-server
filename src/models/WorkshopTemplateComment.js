const mongoose = require("mongoose");

const workshopTemplateCommentSchema = new mongoose.Schema(
  {
    templateId: { type: String, required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

workshopTemplateCommentSchema.index({ templateId: 1, createdAt: -1 });

module.exports = mongoose.model("WorkshopTemplateComment", workshopTemplateCommentSchema);