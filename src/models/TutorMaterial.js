// src/models/TutorMaterial.js
// 一门课的一份教材（原件私有，在 Cloudinary raw；文字由浏览器抽好经 confirm 送来，按页存 TutorChunk）。
// {course, sha} 唯一 = 按 sha256 去重（docs/02 1.7：同一份文件再传不产生第二条、不重复计费）。
// license.source 缺失当 "unsure"（judge 否定）；unsure 只要有一份，这门课铸出的人格就发不了（docs/02 1.4）——
// 事后可改（PATCH /api/tutor/materials/:sha），文档头 license.source 跟着全体教材取最差重算。
const mongoose = require("mongoose");
const { LICENSE_SOURCES } = require("../tutor/core/format/constants.js");

const tutorMaterialSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    sha: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    name: { type: String, required: true, maxlength: 200 },
    ext: { type: String, required: true, maxlength: 10 },
    bytes: { type: Number, default: 0 },
    units: { type: Number, default: 0 }, // 页 / 幻灯 / 段落组数（= TutorChunk 条数）
    chars: { type: Number, default: 0 },
    license: { source: { type: String, enum: LICENSE_SOURCES, default: "unsure" } },
    parsed: {
      status: { type: String, enum: ["ok", "failed", "pending"], default: "pending" },
      chars: { type: Number, default: 0 },
      sections: { type: Number, default: 0 },
      warnings: { type: [String], default: [] },
    },
    // Cloudinary raw 的 public_id（服务端签死，docs/05 §4.3 三条纪律）；取回走 directDownloadUrl（raw 公开投递一律 401）
    publicId: { type: String, default: "" },
    from: { type: String, enum: ["browser", "import"], default: "browser" },
  },
  { timestamps: true },
);

tutorMaterialSchema.index({ course: 1, sha: 1 }, { unique: true });

module.exports = mongoose.model("TutorMaterial", tutorMaterialSchema);
