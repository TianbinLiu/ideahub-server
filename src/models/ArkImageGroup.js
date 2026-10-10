// src/models/ArkImageGroup.js
// 一组「组图」出图任务（方舟 Seedream `sequential_image_generation: "auto"`，2026-10-05）。
//
// ★★ 为什么要落库、而不是让客户端同步等：一组 6 张实测 249 秒（2026-10-05 付费对比），9 张约 6 分钟，
//   而客户端到我们之间挡着 Cloudflare 的 125 秒读超时 —— 同步那一发必断，断了钱已经扣、图一张都拿不到。
//   所以照视频任务的样子走「受理 → 后台画 → 客户端短轮询」：POST 立刻回任务号，每画好一张就追加进 images，
//   客户端边等边看。
// ★ 钱：受理时按「上限 × 单价」预扣，结束时按**拿到手的张数**结算、多退少不补（services/arkImageGroup）。
//   prepaid / charged 两格就是这笔账的两头，对账时不用再去流水里拼。
// ★ 「同一个人同时只画一组」由下面那条部分唯一索引兜底（并发两发 POST 只有一发建得出来），
//   不靠"先查再建"——查和建之间的窗口正是并发的入口。
const mongoose = require("mongoose");

const imageSchema = new mongoose.Schema(
  {
    /** 方舟给的 image_index（从 0 起）= 提示词里第几个镜头。被审核拦下的那一张不在这里，序号会跳 */
    index: { type: Number, required: true },
    /** 方舟临时链接（24 小时有效）：客户端拿到就转存成自己的 */
    url: { type: String, required: true, maxlength: 2000 },
    size: { type: String, default: "", maxlength: 24 },
  },
  { _id: false },
);

const failureSchema = new mongoose.Schema(
  {
    index: { type: Number, default: -1 },
    /** 方舟错误码原样（审核不过是 OutputImageSensitiveContentDetected）：给人看的话由客户端按码说 */
    code: { type: String, default: "", maxlength: 80 },
    message: { type: String, default: "", maxlength: 300 },
  },
  { _id: false },
);

const arkImageGroupSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    /** running → done（至少拿到一张）/ failed（一张都没有，钱全退） */
    status: { type: String, enum: ["running", "done", "failed"], default: "running" },
    /** 客户端发来的出图 id（在册、计价、GET 回给客户端的都是它 —— 含义没变） */
    model: { type: String, required: true, maxlength: 80 },
    /**
     * 真发给方舟的型号（2026-10-10：方舟下线了的老 id 由出口换成接班型号，config/tokens.upstreamImageModel）。
     * 没接班时与 model 相同。只为对账：受理 / 结算 / 懒回收三笔流水的 memo 都按它写（一组可能横跨切换时刻，不现算）。
     * 不回给客户端。字段上线之前的老组没有它（undefined）= 当时没换。
     */
    upstreamModel: { type: String, default: undefined, maxlength: 80 },
    maxImages: { type: Number, required: true },
    /** 一张多少 token（受理那一刻的价目表，结算按它算，价目表中途改了也不影响这一组） */
    unitCost: { type: Number, required: true },
    /** 实际预扣了多少（管理员免单 = 0）。受理后才写 */
    prepaid: { type: Number, default: 0 },
    /** 管理员免单：不动余额，结束时按实际张数记一笔 admin_free */
    free: { type: Boolean, default: false },
    /**
     * 预扣时从哪两桶各扣了多少（billing.preAuthorize 的 took）。一张没拿到时**按它原样退回**（plan 回 plan、addon 回 addon）。
     * ★ 2026-10-07 加：之前全退进 addon，「要 15 张、一张不给」就成了把当月额度洗成永久余额的路。
     *   老的那几组没有这一位（undefined）→ 退款兜底进 addon（改版前的行为）。
     */
    took: {
      type: new mongoose.Schema({ plan: { type: Number, min: 0 }, addon: { type: Number, min: 0 } }, { _id: false }),
      default: undefined,
    },
    images: { type: [imageSchema], default: [] },
    failures: { type: [failureSchema], default: [] },
    /** 结算按的张数 = 拿到手的张数（≤ maxImages） */
    generated: { type: Number, default: 0 },
    /** 方舟 usage.generated_images 原样（对账用：与 generated 不等时打日志） */
    upstreamGenerated: { type: Number, default: undefined },
    /** 最终实收（免单 = 0） */
    charged: { type: Number, default: 0 },
    /** 整组失败的原因 / 中途断开的说明（英文原话或我们的整句；客户端按 code / interrupted 自己说） */
    message: { type: String, default: "", maxlength: 300 },
    code: { type: String, default: "", maxlength: 80 },
    /** 没等到方舟说「画完了」就结束了（连接断开 / 超时 / 服务重启）：画到哪张算哪张 */
    interrupted: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: undefined },
  },
  { timestamps: true, versionKey: false },
);

// 同一个人同时只有一组在画（见文件头 ★）
arkImageGroupSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: "running" }, name: "one_running_group_per_user" },
);
arkImageGroupSchema.index({ userId: 1, createdAt: -1 });
// 方舟链接 24 小时就失效，多留一天是让「已过期」那句话还有的说（与 ArkVideoTask 同口径）
arkImageGroupSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 60 * 60 });

module.exports = mongoose.model("ArkImageGroup", arkImageGroupSchema);
