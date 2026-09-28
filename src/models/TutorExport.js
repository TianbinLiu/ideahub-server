// src/models/TutorExport.js
// 导出留痕（docs/02 5.4；《标识办法》第九条日志 ≥ 6 个月）：谁 / 何时 / 哪版 / 格式 / sha256 / 标识元数据。只追加。
// 形状 = core/export/index.js 的 exportRecord()；retainDays 只是给界面看的数，真删不在 M1。
const mongoose = require("mongoose");

const tutorExportSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    xid: { type: String, required: true }, // exportRecord().id
    at: { type: String, required: true },
    by: { type: String, default: "author" },
    audience: { type: String, enum: ["market", "self"], required: true },
    version: { type: Number, required: true },
    format: { type: String, enum: ["md", "json", "zip"], required: true },
    bytes: { type: Number, default: 0 },
    sha256: { type: String, default: "" },
    checksum: { type: String, default: "" },
    ProduceID: { type: String, default: "" },
    ContentProducer: { type: String, default: "" },
    retainDays: { type: Number, default: 180 },
    cleanCheck: { type: String, enum: ["passed", "skipped"], default: "passed" },
    name: { type: String, default: "" },
  },
  { timestamps: true },
);

tutorExportSchema.index({ course: 1, createdAt: -1 });

module.exports = mongoose.model("TutorExport", tutorExportSchema);
