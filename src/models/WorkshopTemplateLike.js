const mongoose = require("mongoose");

const workshopTemplateLikeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: "WorkshopTemplate", required: true, index: true },
  },
  { timestamps: true }
);

workshopTemplateLikeSchema.index({ user: 1, template: 1 }, { unique: true });

module.exports = mongoose.model("WorkshopTemplateLike", workshopTemplateLikeSchema);
