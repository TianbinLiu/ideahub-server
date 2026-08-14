// src/models/BranchTemplateTrial.js
// 白模模板的试炼追踪：一条 = 「某个 r2v 任务是用哪个模板、由谁发起的」。
//
// 为什么需要这张表：发布模板的前置是 provenAt（作者本人真实出过一次片，见
// BranchTemplate.provenAt 的注释），而「出没出过」必须由**服务端可验证的证据**判定，
// 不能信客户端自述。方舟的任务创建与轮询都走我们的代理（ark.routes.js），所以证据链是：
//   创建 r2v 任务被方舟受理 → 在这里落一条 { taskId, templateId, userId }
//   轮询看到该 taskId status === "succeeded" 且 userId 就是模板作者 → 置 provenAt
// 两步都发生在服务端，客户端全程没有插手的机会。
//
// ★ TTL 48h：追踪只为「受理 → 出结果」这一小段生命周期服务（Seedance 任务几分钟内
//   就有结果，方舟侧任务记录本身也只保 24h 级），过期自动清掉，不用任何人惦记回收。
//   轮询到 succeeded 后也会主动删（见 ark.routes.js 的 noteR2vOutcome），TTL 是兜底。
const mongoose = require("mongoose");

const branchTemplateTrialSchema = new mongoose.Schema(
  {
    /** 方舟任务 id（cgt-…）。已过 ark.routes 的 TASK_ID_RE 收口 */
    taskId: { type: String, required: true, trim: true, maxlength: 64 },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "BranchTemplate", required: true },
    /** 任务发起人。试炼闸比较的是它与模板 ownerId，**不是**轮询者是谁 ——
     *  轮询端点谁都能打，但这条记录只在创建任务被受理的那一刻由服务端写入 */
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, versionKey: false }
);

// 轮询按 taskId 查，一个任务只有一条
branchTemplateTrialSchema.index({ taskId: 1 }, { unique: true });
// TTL 兜底回收（48h）
branchTemplateTrialSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model("BranchTemplateTrial", branchTemplateTrialSchema);
