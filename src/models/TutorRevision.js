// src/models/TutorRevision.js
// 修订记录（docs/03 §7.4）：append-only，头文档 = fold(seed, 全部 accepted ops)。一条记录 = 一批 ops（蒸馏 / 阅读面手记 / 扫描点头 / 导入 / 撤销）。
// 与 tutor 仓 .tutor/revisions.jsonl 的一行同形；core/ops/revision.js 经 store（read / append / write）读写它 ——
// review / revert 只改原记录里各条 op 的 status（write 整批回写），撤销另加一条 kind:revert，历史不删。
const mongoose = require("mongoose");
const { REVISION_KINDS } = require("../tutor/core/ops/revision.js");

const tutorRevisionSchema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: "TutorRun", required: true, index: true },
    rid: { type: String, required: true }, // 记录自己的 16 hex id（sha256 of created_at:kind:opIds）
    seq: { type: Number, required: true }, // 本 Run 内的序号（读回来按它排；jsonl 里靠行序）
    kind: { type: String, enum: REVISION_KINDS, required: true },
    ops: { type: mongoose.Schema.Types.Mixed, default: [] },
    summary: { type: String, default: "" },
    source: { type: mongoose.Schema.Types.Mixed, default: {} },
    by: { type: String, enum: ["ai", "user"], required: true },
    review: { type: String, default: "n/a" }, // pending / accepted / rejected / reverted / n/a
    of: { type: String }, // kind:revert 指向被撤销的那条 rid
    created_at: { type: String, required: true },
  },
  { timestamps: false, versionKey: false, minimize: false },
);

tutorRevisionSchema.index({ run: 1, seq: 1 }, { unique: true });
tutorRevisionSchema.index({ run: 1, rid: 1 }, { unique: true });

module.exports = mongoose.model("TutorRevision", tutorRevisionSchema);
