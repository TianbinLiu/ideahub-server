/**
 * @file TakedownRequest.js - 非自愿私密影像（NCII）的移除请求
 * @category Model
 * @collection takedownrequests
 *
 * 📖 [AI] 修改前必读: /.ai-instructions.md
 * 🔄 [AI] 修改后必须: 同步更新 PROJECT_STRUCTURE.md 模型章节 + 官网 /takedown 页（两边说的必须是同一套流程）
 *
 * ── 法条出处（TAKE IT DOWN Act, Pub. L. 119-12 §3；2026-05-19 起 FTC 执法，无小企业豁免）──
 * §3(a) 要求平台在站上**显著公示**移除流程；§3(b) 要求收到**有效请求**后
 * **「as soon as possible, but not later than 48 hours」** 移除，并
 * **「make reasonable efforts to identify and remove any known identical copies」**。
 *
 * 「有效请求」的四个要件（原文 §3(b)(1)(A)，逐条对应下面的字段）：
 *   (i)   a physical or electronic signature of the identifiable individual   → `signature`
 *   (ii)  identification of, and information reasonably sufficient to locate,
 *         the intimate visual depiction                                        → `urls` + `locationNote`
 *   (iii) a brief statement of good faith belief that it is not consensual     → `statement` + `affirmedNotConsensual`
 *   (iv)  information sufficient to contact the individual                     → `contactEmail`（+ 选填 `contactPhone`）
 *
 * ★★ **不要求请求人有账号。** 受害者通常不是我们的用户 —— 把入口挡在登录后面，
 *    等于这条通道对绝大多数真正需要它的人不存在。所以 `POST /api/takedown` 免登录，
 *    只按 IP 限流；滥用由「**人工复核之后才移除**」兜住，而不是靠登录门槛。
 * ★★ **这张表不随删号级联清掉**（与 `Report` 的 `URGENT_REASONS` 同一条道理）：
 *    被举报的账号一注销就把移除记录抹掉的话，我们将无法证明自己在 48 小时内处理过 ——
 *    而 FTC 执法看的正是这个。同理**不设 TTL**。
 * ★ **不存请求人的 IP / UA。** 法条不要求，而这是受害者的信息，多留一份就多一份泄露面。
 *   反滥用靠限流（在中间件里按 IP 计数，不落库）。
 *
 * @field kind {String} 目前只有 ncii；留着是因为 DMCA 之类将来大概率共用这条流程
 * @field signature {String} 请求人逐字打上的本人姓名 = 电子签名（§3(b)(1)(A)(i)）
 * @field onBehalf {String} self | authorized（本人 / 受本人授权的代理人）
 * @field contactEmail {String} 必填
 * @field urls {[String]} 内容位置（§3(b)(1)(A)(ii)）
 * @field statement {String} 好意相信未经同意的简短陈述（§3(b)(1)(A)(iii)）
 * @field receivedAt / dueAt {Date} dueAt = receivedAt + 48h，**是承诺不是目标**
 * @field status {String} pending | removed | rejected | need_info
 * @field removed {[Object]} 实际移除了什么，含「已知相同副本」那部分
 *
 * @index {status:1, dueAt:1} 待处理队列按到期时间升序（最急的在最前）
 * @used_in routes/takedown.routes.js, services/nciiTakedown.service.js
 */
const mongoose = require("mongoose");

const KINDS = ["ncii"];
const ON_BEHALF = ["self", "authorized"];
const STATUSES = ["pending", "removed", "rejected", "need_info"];

/** 48 小时是法定上限（§3(b)(1)）。★ 一处实现：路由、清扫、官网文案都引这个常数 */
const SLA_MS = 48 * 60 * 60 * 1000;

const takedownRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, default: "ncii", required: true },

    // ── 有效请求的四个要件 ──────────────────────────────────
    signature: { type: String, trim: true, required: true, maxlength: 120 },
    onBehalf: { type: String, enum: ON_BEHALF, default: "self", required: true },
    contactEmail: { type: String, trim: true, required: true, maxlength: 200 },
    contactPhone: { type: String, trim: true, default: "", maxlength: 40 },
    urls: { type: [String], default: [] },
    locationNote: { type: String, trim: true, default: "", maxlength: 2000 },
    statement: { type: String, trim: true, default: "", maxlength: 2000 },
    /** 勾选「我确信这段影像未经我同意」。没勾 = 请求不完整，路由直接 400 */
    affirmedNotConsensual: { type: Boolean, default: false, required: true },

    // ── 时限 ────────────────────────────────────────────────
    receivedAt: { type: Date, default: Date.now, required: true },
    dueAt: { type: Date, required: true },

    status: { type: String, enum: STATUSES, default: "pending", required: true },

    // ── 处理 ────────────────────────────────────────────────
    handler: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    handledAt: { type: Date, default: null },
    handleNote: { type: String, trim: true, default: "", maxlength: 1000 },
    /**
     * 实际移除了什么。★ 「已知相同副本」（§3(b)(1)(B)）的履行证据就在这里：
     * 同一个资产地址被别的作品/卡组/头像引用时，那几条也会出现在这个数组里。
     */
    removed: {
      type: [
        {
          _id: false,
          model: { type: String, default: "" },
          id: { type: String, default: "" },
          field: { type: String, default: "" },
          url: { type: String, default: "" },
          action: { type: String, default: "" },
        },
      ],
      default: [],
    },
    /** 副本检索跑过没有、跑出多少条。跑过但是 0 条，与根本没跑过，是两件事 */
    copySearch: {
      ranAt: { type: Date, default: null },
      foundCount: { type: Number, default: 0 },
      /** 哪些表的命中数撞到了单表上限 —— 非空 = 这次检索**不完整**，foundCount 不能当完整证据 */
      truncated: { type: [String], default: [] },
    },
    /** 到期提醒发到哪一档了（"soon" / "overdue"），避免每轮清扫都重发 */
    reminderStage: { type: String, default: "" },
  },
  { timestamps: true }
);

// 待处理队列：先按到期时间升序（最急的在最前），再按收到时间。
// ★ 与 takedown.routes 的 sort 必须**逐字一致**（Report 那张索引的教训：多一个 _id
//   就会在 explain 里多出阻塞 SORT 阶段，零报错、只是慢，堆到内存上限则整条查询抛错）。
takedownRequestSchema.index({ status: 1, dueAt: 1 });

// dueAt 由 receivedAt 推导，不接受调用方传值 —— 能传的话「48 小时」就成了一个可以自己往后挪的数字。
takedownRequestSchema.pre("validate", function setDue() {
  if (!this.receivedAt) this.receivedAt = new Date();
  // ★ 判据是 **isNew**，两头都要守住（2026-09-25 评审）：
  //   · 新文档：**无条件覆盖**调用方传进来的 dueAt —— 48 小时不是一个能自己往后挪的数字；
  //   · 已有文档：**一个字都不动** —— 原来每次 save 都重算，而 `/scan` 与到期清扫都会 save，
  //     于是针对「同一档不重发」的那条测试变成空跑（save 一次就把 dueAt 推回 +48h）。
  if (this.isNew) this.dueAt = new Date(this.receivedAt.getTime() + SLA_MS);
});

module.exports = mongoose.model("TakedownRequest", takedownRequestSchema);
module.exports.KINDS = KINDS;
module.exports.ON_BEHALF = ON_BEHALF;
module.exports.STATUSES = STATUSES;
module.exports.SLA_MS = SLA_MS;
