// src/models/TutorChunk.js
// 教材的块级文本，**一页一条**（docs/02 1.12：{ idx, title?, blocks[{ hash, text, bbox? }] }，与浏览器 / Node 同一份切块，块 hash 逐块相同 —— 锚点靠它钉回去）。
// {material, idx} 唯一。纯文本、作者私有：泄漏核查（cleanCheck）与检索都读它，**永不进任何可导出对象**（docs/03 §8 末行）。
// 为什么不整份塞进 TutorMaterial：一本 300 页教材的 pages 几 MB，Mongo 单文档 16MB 是硬顶、且读一页要拉整份。
const mongoose = require("mongoose");

const blockSchema = new mongoose.Schema(
  { hash: { type: String, required: true, match: /^[0-9a-f]{12}$/ }, text: { type: String, required: true }, bbox: { type: [Number], default: undefined } },
  { _id: false },
);

const tutorChunkSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: "TutorCourse", required: true, index: true },
    material: { type: mongoose.Schema.Types.ObjectId, ref: "TutorMaterial", required: true },
    sha: { type: String, required: true },
    idx: { type: Number, required: true }, // 页号，从 1 起（与锚点 anchor.page 同一个数）
    title: { type: String },
    blocks: { type: [blockSchema], default: [] },
  },
  { timestamps: false, versionKey: false },
);

tutorChunkSchema.index({ material: 1, idx: 1 }, { unique: true });

module.exports = mongoose.model("TutorChunk", tutorChunkSchema);
